import crypto from "node:crypto";
import { Pool } from "pg";
import { waitUntil } from "@neon/functions";
import {
  DEFAULT_CONFIG,
  createAccount,
  markAccount,
  riskDecision,
  openPaper,
  closePaper,
  evaluateExit,
  enforceKillSwitch
} from "../dist/core.js";
import { createStrategy } from "../dist/strategies.js";
import { CoinbaseFeed } from "../dist/feed.js";
import { coinbaseConfigured, probeCoinbase } from "./coinbase.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const RUNNER = "neon-scheduled";
const LOCK_KEY = "survival-lab-neon-runner";
const WINDOW_MS = boundedInt(process.env.TRADER_WINDOW_MS, 55_000, 5_000, 58_000);
const SAMPLE_MS = boundedInt(process.env.TRADER_SAMPLE_MS, 1_000, 500, 5_000);
const HISTORY_LIMIT = 90;

const KIND_BY_TYPE = Object.freeze({
  "run.started": "run_start",
  "run.ended": "run_end",
  "agent.consensus": "decision",
  "strategy.target": "decision",
  "risk.decision": "decision",
  "execution.fill": "trade",
  "market.observation": "system",
  "feed.error": "system",
  "runner.state": "control"
});

function boundedInt(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function controlToken() {
  const databaseUrl=process.env.DATABASE_URL||"";
  return databaseUrl ? sha256("survival-lab-control-v1:"+databaseUrl) : "";
}

function createEvidenceRun() {
  const runId = crypto.randomUUID();
  let sequence = 0;
  let prevHash = "0".repeat(64);
  const records = [];
  return {
    runId,
    records,
    append(type, data = {}, tick = 0) {
      const occurred_at = new Date().toISOString();
      const base = {
        run_id: runId,
        sequence: ++sequence,
        tick,
        kind: KIND_BY_TYPE[type] || "system",
        occurred_at,
        event_type: type,
        payload: data,
        prev_hash: prevHash
      };
      const hash = sha256(canonical(base));
      records.push({
        run_id: base.run_id,
        sequence: base.sequence,
        tick: base.tick,
        kind: base.kind,
        occurred_at: base.occurred_at,
        payload: { event_type: type, data, evidence: { prev_hash: prevHash, hash } }
      });
      prevHash = hash;
    }
  };
}

function restoreState(raw) {
  if (!raw || typeof raw !== "object") {
    return { tick: 0, account: createAccount(), history: [], lastStrategySequence: null };
  }
  return {
    tick: Number.isInteger(raw.tick) && raw.tick >= 0 ? raw.tick : 0,
    account: raw.account && typeof raw.account === "object" ? raw.account : createAccount(),
    history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [],
    lastStrategySequence: raw.lastStrategySequence ?? null
  };
}

async function loadState(client) {
  const { rows } = await client.query(`
    SELECT payload->'data'->'state' AS state
    FROM public.survival_events
    WHERE payload->>'event_type'='runner.state'
      AND payload->'data'->>'runner'=$1
    ORDER BY occurred_at DESC, received_at DESC
    LIMIT 1
  `, [RUNNER]);
  return restoreState(rows[0]?.state);
}

async function alreadyCompleted(client, scheduledAt) {
  const { rowCount } = await client.query(`
    SELECT 1
    FROM public.survival_events
    WHERE payload->>'event_type'='runner.state'
      AND payload->'data'->>'runner'=$1
      AND payload->'data'->>'scheduled_at'=$2
    LIMIT 1
  `, [RUNNER, scheduledAt]);
  return rowCount > 0;
}

async function insertRecords(client, records) {
  if (!records.length) return;
  await client.query("BEGIN");
  try {
    await client.query(`
      INSERT INTO public.survival_events(run_id,sequence,tick,kind,occurred_at,payload)
      SELECT x.run_id::uuid,x.sequence,x.tick,x.kind,x.occurred_at,x.payload
      FROM jsonb_to_recordset($1::jsonb)
        AS x(run_id text,sequence integer,tick integer,kind text,occurred_at timestamptz,payload jsonb)
      ON CONFLICT (run_id,sequence) DO NOTHING
    `, [JSON.stringify(records)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processSnapshot(state, strategy, evidence, quote) {
  state.tick++;
  const observation = { ...quote };
  state.history.push(observation);
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.lastStrategySequence = quote.sequence ?? state.lastStrategySequence;
  evidence.append("market.observation", observation, state.tick);
  markAccount(state.account, observation);

  strategy.observe(observation);
  const target = strategy.target();
  const now = Date.now();
  let exit = evaluateExit(state.account, observation, target.score, now);
  const position = state.account.position;

  evidence.append("strategy.target", {
    strategy_id: target.strategy_id,
    exposure: target.exposure,
    confidence: target.confidence,
    leader: target.leader,
    rationale: target.rationale,
    explanation: target.explanation,
    exit_gate: position ? {
      age_ms: Math.max(0, now - position.openedAt),
      flip_confirmations: position.flipConfirmations || 0,
      required_confirmations: DEFAULT_CONFIG.exitFlipConfirmations,
      flip_threshold: DEFAULT_CONFIG.exitFlipThreshold,
      min_hold_ms: DEFAULT_CONFIG.minHoldMs
    } : null
  }, state.tick);

  const killed = enforceKillSwitch(state.account);
  if (killed && state.account.position) exit = "kill switch: " + killed;

  if (exit) {
    const fill = closePaper(state.account, observation, exit, now);
    evidence.append("execution.fill", {
      kind: "close",
      strategy_id: target.strategy_id,
      ...fill,
      equity: state.account.equity
    }, state.tick);
  } else if (!state.account.position) {
    const intent = {
      strategy_id: target.strategy_id,
      score: target.score,
      target_exposure: target.exposure,
      confidence: target.confidence,
      leader: target.leader
    };
    const risk = riskDecision(state.account, observation, intent, now);
    if (risk.halt) {
      state.account.halted = true;
      state.account.haltReason = risk.reason;
    }
    evidence.append("risk.decision", { intent, ...risk }, state.tick);
    if (risk.allowed) {
      const fill = openPaper(state.account, observation, intent, risk, now);
      evidence.append("execution.fill", {
        kind: "open",
        strategy_id: target.strategy_id,
        ...fill,
        score: target.score,
        target_exposure: target.exposure
      }, state.tick);
    }
  }

  markAccount(state.account, observation);
  enforceKillSwitch(state.account);
  return target;
}

async function runWindow(state, strategy, evidence) {
  const feed = new CoinbaseFeed("BTC-USD");
  let samples = 0;
  let lastTarget = null;
  try {
    const first = await feed.next(5_000);
    const deadline = Date.now() + WINDOW_MS;
    let nextSampleAt = Date.now();
    let candidate = first;
    while (Date.now() < deadline) {
      candidate = feed.latest() || candidate;
      if (candidate) {
        const age = Date.now() - candidate.receivedAt;
        const isNew = candidate.sequence == null || candidate.sequence !== state.lastStrategySequence;
        if (age <= DEFAULT_CONFIG.maxQuoteAgeMs && isNew) {
          lastTarget = processSnapshot(state, strategy, evidence, candidate);
          samples++;
        }
      }
      nextSampleAt += SAMPLE_MS;
      await sleep(Math.max(10, nextSampleAt - Date.now()));
    }
  } finally {
    feed.close();
  }
  return { samples, lastTarget };
}

async function handleScheduled(request) {
  const triggerInvocationId = request.headers.get("x-neon-trigger-invocation-id");
  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const expectedControlToken=controlToken();
  const controlAuthorized = Boolean(expectedControlToken) && bearer === expectedControlToken;
  if (!triggerInvocationId && !controlAuthorized) {
    return Response.json({ error: "unauthorized invocation" }, { status: 403 });
  }

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "invalid trigger payload" }, { status: 400 }); }
  const scheduledAt = body?.data?.scheduled_at;
  if (!scheduledAt) return Response.json({ error: "scheduled_at missing" }, { status: 400 });
  const invocationId = triggerInvocationId || body?.data?.invocation_id || ("control-" + scheduledAt);

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired",
      [LOCK_KEY]
    );
    locked = Boolean(lock.rows[0]?.acquired);
    if (!locked) return Response.json({ ok: true, skipped: "runner busy", scheduled_at: scheduledAt }, { status: 202 });

    if (await alreadyCompleted(client, scheduledAt)) {
      return Response.json({ ok: true, duplicate: true, scheduled_at: scheduledAt });
    }

    const state = await loadState(client);
    const strategy = createStrategy("consensus-six");
    for (const observation of state.history) strategy.observe(observation);

    const evidence = createEvidenceRun();
    evidence.append("run.started", {
      mode: RUNNER,
      config: DEFAULT_CONFIG,
      product: "BTC-USD",
      market_transport: "coinbase-websocket",
      strategy: strategy.manifest,
      scheduled_at: scheduledAt,
      invocation_id: invocationId,
      window_ms: WINDOW_MS,
      sample_ms: SAMPLE_MS
    }, state.tick);

    let samples = 0;
    let lastTarget = null;
    let error = null;
    try {
      ({ samples, lastTarget } = await runWindow(state, strategy, evidence));
    } catch (e) {
      error = String(e?.message || e);
      evidence.append("feed.error", { message: error }, state.tick);
    }

    evidence.append("runner.state", {
      runner: RUNNER,
      scheduled_at: scheduledAt,
      invocation_id: invocationId,
      samples,
      state: {
        tick: state.tick,
        account: state.account,
        history: state.history.slice(-HISTORY_LIMIT),
        lastStrategySequence: state.lastStrategySequence
      }
    }, state.tick);

    evidence.append("run.ended", {
      mode: RUNNER,
      scheduled_at: scheduledAt,
      invocation_id: invocationId,
      samples,
      error,
      strategy_id: "consensus-six",
      last_target: lastTarget ? {
        exposure: lastTarget.exposure,
        confidence: lastTarget.confidence,
        leader: lastTarget.leader
      } : null,
      account: {
        cash: state.account.cash,
        equity: state.account.equity,
        realized: state.account.realized,
        trades: state.account.trades,
        wins: state.account.wins,
        losses: state.account.losses,
        halted: state.account.halted,
        haltReason: state.account.haltReason,
        position: state.account.position
      }
    }, state.tick);

    await insertRecords(client, evidence.records);
    console.log(JSON.stringify({
      event: "survival.runner.complete",
      scheduled_at: scheduledAt,
      run_id: evidence.runId,
      samples,
      tick: state.tick,
      equity: state.account.equity,
      error
    }));

    return Response.json({
      ok: true,
      scheduled_at: scheduledAt,
      run_id: evidence.runId,
      samples,
      tick: state.tick,
      equity: state.account.equity,
      account: {
        cash: state.account.cash,
        equity: state.account.equity,
        realized: state.account.realized,
        trades: state.account.trades,
        wins: state.account.wins,
        losses: state.account.losses,
        halted: state.account.halted,
        haltReason: state.account.haltReason,
        position: state.account.position
      },
      error
    }, { status: error ? 207 : 200 });
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [LOCK_KEY]); }
      catch {}
    }
    client.release();
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok:true,runner:RUNNER,window_ms:WINDOW_MS,sample_ms:SAMPLE_MS,
        coinbase:{configured:coinbaseConfigured(),execution:"paper-only"}
      });
    }
    if (request.method === "GET" && url.pathname === "/coinbase/probe") {
      const bearer=(request.headers.get("authorization")||"").replace(/^Bearer\s+/,"");
      const expectedControlToken=controlToken();
      if(!expectedControlToken||bearer!==expectedControlToken){
        return Response.json({error:"unauthorized"},{status:403});
      }
      if(!coinbaseConfigured())return Response.json({ok:false,configured:false},{status:503});
      try{
        return Response.json({configured:true,...await probeCoinbase()});
      }catch(error){
        return Response.json({ok:false,configured:true,error:String(error?.message||error),status:error?.status||null},{status:502});
      }
    }
    if (request.method !== "POST" || url.pathname !== "/") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const bearer=(request.headers.get("authorization")||"").replace(/^Bearer\s+/,"");
      const expectedControlToken=controlToken();
      const isControl=Boolean(expectedControlToken)&&bearer===expectedControlToken;
      const isNeonTrigger=Boolean(request.headers.get("x-neon-trigger-invocation-id"));
      if(isControl&&!isNeonTrigger){
        waitUntil(handleScheduled(request.clone()).catch(error=>{
          console.error("survival runner background failure",error);
        }));
        return Response.json({ok:true,accepted:true,window_ms:WINDOW_MS},{status:202});
      }
      return await handleScheduled(request);
    } catch (error) {
      console.error("survival runner failed", error);
      return Response.json({ error: "runner failed", detail: String(error?.message || error) }, { status: 500 });
    }
  }
};
