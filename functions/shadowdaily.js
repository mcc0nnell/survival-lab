import crypto from "node:crypto";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { parseTriggerDelivery } from "@neon/functions/triggers";
import { runDonchianForwardShadow, DONCHIAN_SHADOW_START } from "../dist/backtest.js";

export const TRIGGER_NAME = "trader-daily-shadow";
export const HISTORY_URL = "https://survival-lab-evidence.stokoe.workers.dev/api/history";
export const FRICTION_BPS = 21.5;
const DAY_MS = 86400000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
attachDatabasePool(pool);

function closedDayAsOf(scheduledAt) {
  const ms = new Date(scheduledAt).getTime();
  if (!Number.isFinite(ms)) throw new Error("invalid schedule timestamp");
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS - DAY_MS).toISOString().slice(0, 10);
}

export function evaluateFrozenShadow(history, scheduledAt) {
  if (!history?.ok || history.product !== "BTC-USD" || history.cadence !== "1d" ||
      history.provider !== "kraken-spot" || !Array.isArray(history.observations)) {
    throw new Error("unexpected spot history contract");
  }
  const asOf = closedDayAsOf(scheduledAt);
  const startDate = DONCHIAN_SHADOW_START.slice(0, 10);
  if (asOf < startDate) throw new Error("scheduled before the forward-shadow freeze");
  const observations = history.observations.filter((bar) =>
    typeof bar.observed_at === "string" && bar.observed_at.slice(0, 10) <= asOf
  );
  const latest = observations.at(-1)?.observed_at?.slice(0, 10);
  if (latest !== asOf) throw new Error("daily history is stale: expected " + asOf + ", got " + (latest ?? "none"));
  const expectedBars = Math.round((Date.parse(asOf + "T00:00:00Z") -
    Date.parse(DONCHIAN_SHADOW_START)) / DAY_MS) + 1;
  const dates = new Set(observations.filter((bar) => bar.observed_at.slice(0, 10) >= startDate)
    .map((bar) => bar.observed_at.slice(0, 10)));
  if (dates.size !== expectedBars) {
    throw new Error("missing forward bars: expected " + expectedBars + ", got " + dates.size);
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(observations)).digest("hex");
  const dataset = { id: "btc-usd-spot-1d", observations, count: observations.length };
  const shadow = runDonchianForwardShadow({ spotDataset: dataset, costBps: FRICTION_BPS });
  if (shadow.results.length !== 2 || shadow.results.some((r) => r.observations !== expectedBars)) {
    throw new Error("incomplete frozen shadow result");
  }
  return {
    asOf,
    startDate,
    historySha256: digest,
    observations: expectedBars,
    results: shadow.results.map((r) => ({
      strategy_id: r.id,
      observations: r.observations,
      total_return: r.total_return,
      max_drawdown: r.max_drawdown,
      sharpe: r.sharpe,
      turnover: r.turnover
    }))
  };
}

export async function fetchSpotHistory(fetchImpl = fetch) {
  const url = new URL(HISTORY_URL);
  url.searchParams.set("product", "BTC-USD");
  url.searchParams.set("cadence", "1d");
  url.searchParams.set("days", "730");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", origin: "https://trader.mcc0nnell.org" },
    signal: AbortSignal.timeout(30000),
    cache: "no-store"
  });
  if (!response.ok) throw new Error("history endpoint returned HTTP " + response.status);
  return response.json();
}

async function persistFrozenShadow(report) {
  const client = await pool.connect();
  try {
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "survival_lab") throw new Error("refusing to write outside survival_lab");
    await client.query("BEGIN");
    for (const result of report.results) {
      await client.query(
        "INSERT INTO public.shadow_daily_results " +
        "(as_of,strategy_id,evaluation_start,observations,total_return,max_drawdown,sharpe,turnover,cost_bps,history_sha256) " +
        "VALUES ($1::date,$2,$3::date,$4,$5,$6,$7,$8,$9,$10) " +
        "ON CONFLICT (as_of,strategy_id) DO UPDATE SET " +
        "observations=EXCLUDED.observations,total_return=EXCLUDED.total_return," +
        "max_drawdown=EXCLUDED.max_drawdown,sharpe=EXCLUDED.sharpe," +
        "turnover=EXCLUDED.turnover,cost_bps=EXCLUDED.cost_bps," +
        "history_sha256=EXCLUDED.history_sha256,computed_at=now()",
        [report.asOf, result.strategy_id, report.startDate, result.observations,
          result.total_return, result.max_drawdown, result.sharpe,
          result.turnover, FRICTION_BPS, report.historySha256]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function runDailyShadow(scheduledAt, { fetchImpl = fetch, persist = persistFrozenShadow } = {}) {
  const report = evaluateFrozenShadow(await fetchSpotHistory(fetchImpl), scheduledAt);
  await persist(report);
  return {
    ok: true, mode: "research-only", as_of: report.asOf,
    observations: report.observations,
    strategies: report.results,
    history_sha256: report.historySha256
  };
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/healthz") {
      return Response.json({ ok: true, mode: "research-only", orders: "disabled", trigger: TRIGGER_NAME });
    }
    if (request.method !== "POST" || path !== "/daily") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const parsed = await parseTriggerDelivery(request);
    if (!parsed.ok) {
      return Response.json({ error: "unauthorized trigger" }, {
        status: parsed.error === "invalid_body" ? 400 : 401
      });
    }
    const invocation = parsed.invocation;
    if (invocation.type !== "schedule" || invocation.trigger.name !== TRIGGER_NAME) {
      return Response.json({ error: "unexpected trigger" }, { status: 403 });
    }
    try {
      const output = await runDailyShadow(invocation.data.scheduledAt);
      console.log(JSON.stringify({ event: "shadow.daily.completed", ...output }));
      return Response.json(output);
    } catch (error) {
      console.error("shadow.daily.failed", String(error?.message ?? error));
      return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 503 });
    }
  }
};
