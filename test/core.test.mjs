import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, createAccount, computeSignals, consensus,
  markAccount, riskDecision, openPaper, closePaper, evaluateExit, enforceKillSwitch
} from "../dist/core.js";
import { EvidenceLog } from "../dist/evidence.js";
import { parseCoinbaseTicker } from "../dist/feed.js";

const quote=(bid=100,ask=100.02,extra={})=>({
  bid, ask, last:(bid+ask)/2, bidSize:2, askSize:1,
  aggressor:1, receivedAt:Date.now(), ...extra
});

test("stale quotes are rejected",()=>{
  const a=createAccount();
  const now=Date.now();
  const q=quote(100,100.02,{receivedAt:now-DEFAULT_CONFIG.maxQuoteAgeMs-1});
  const r=riskDecision(a,q,{score:.8},now);
  assert.equal(r.allowed,false);
  assert.equal(r.reason,"stale quote");
});

test("paper fills pay spread, slippage and fees",()=>{
  const a=createAccount();
  const now=Date.now()+6000;
  const q=quote(100,100.02,{receivedAt:now});
  const risk=riskDecision(a,q,{score:.8},now);
  assert.equal(risk.allowed,true);
  const opened=openPaper(a,q,{score:.8},risk,now);
  assert.ok(opened.fill>q.ask);
  assert.ok(opened.fee>0);
  assert.ok(a.cash<DEFAULT_CONFIG.initialEquity);
  const q2=quote(101,101.02,{receivedAt:now+6000});
  const closed=closePaper(a,q2,"test",now+6000);
  assert.ok(closed);
  assert.equal(a.position,null);
  assert.ok(Number.isFinite(a.realized));
});

test("six transparent signals stay bounded",()=>{
  const hist=Array.from({length:20},(_,i)=>quote(
    100+i*.1, 100.02+i*.1,
    {last:100.01+i*.1,receivedAt:Date.now()}
  ));
  const signals=computeSignals(hist,hist.at(-1));
  assert.equal(signals.length,6);
  for(const s of signals){
    assert.ok(s.raw>=-1&&s.raw<=1);
    assert.ok(["BUY","SELL","HOLD"].includes(s.vote));
    assert.ok(s.reason.length>0);
  }
  assert.ok(Math.abs(consensus(signals).score)<=1);
});

test("drawdown kill switch halts the account",()=>{
  const a=createAccount();
  a.peak=20;a.equity=17;a.cash=17;a.maxdd=.15;
  assert.equal(enforceKillSwitch(a),"max drawdown");
  assert.equal(a.halted,true);
});

test("mark-to-market does not invent realized pnl",()=>{
  const a=createAccount();
  const now=Date.now()+6000;
  const q=quote(100,100.02,{receivedAt:now});
  const risk=riskDecision(a,q,{score:.9},now);
  openPaper(a,q,{score:.9},risk,now);
  const realized=a.realized;
  markAccount(a,quote(102,102.02,{receivedAt:now+1000}));
  assert.ok(a.equity>a.cash);
  assert.equal(a.realized,realized);
});

test("evidence records match Neon shape and verify their hash chain",async()=>{
  const log=new EvidenceLog();
  const first=await log.append("run.started",{mode:"synthetic"},0);
  const second=await log.append("agent.consensus",{score:.2},1);
  log.close();
  assert.equal(first.kind,"run_start");
  assert.equal(second.kind,"decision");
  assert.equal(first.sequence,1);
  assert.equal(second.tick,1);
  assert.equal(first.payload.event_type,"run.started");
  assert.equal(first.payload.evidence.prev_hash,"0".repeat(64));
  assert.equal(await log.verify([first,second]),true);
});

test("Coinbase WebSocket ticker maps to the market observation contract",()=>{
  const q=parseCoinbaseTicker({
    type:"ticker",sequence:123,product_id:"BTC-USD",price:"83522.93",
    best_bid:"83522.93",best_bid_size:"0.03267153",
    best_ask:"83522.94",best_ask_size:"0.07509586",
    side:"sell",time:"2026-10-01T01:45:39.318007Z",trade_id:1100740314
  },42);
  assert.equal(q.source,"COINBASE_WS");
  assert.equal(q.bid,83522.93);
  assert.equal(q.ask,83522.94);
  assert.equal(q.bidSize,0.03267153);
  assert.equal(q.askSize,0.07509586);
  assert.equal(q.aggressor,1);
  assert.equal(q.sequence,123);
  assert.equal(q.receivedAt,42);
});

test("non-ticker WebSocket messages are ignored",()=>{
  assert.equal(parseCoinbaseTicker({type:"subscriptions"}),null);
});

test("evidence close uses a keepalive flush for queued rows",async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,options)=>{calls.push(options);return {ok:true}};
  try{
    const log=new EvidenceLog({endpoint:"https://example.invalid/api/events"});
    await log.append("run.started",{mode:"test"},0);
    log.close();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(calls.length,1);
    assert.equal(calls[0].keepalive,true);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test("consensus flips require hold time, strength and persistence",()=>{
  const cfg={...DEFAULT_CONFIG,minHoldMs:30000,exitFlipThreshold:.30,exitFlipConfirmations:3};
  const a=createAccount(cfg),t=100000;
  const q=quote(100,100.02,{receivedAt:t});
  const risk=riskDecision(a,q,{score:.8},t,cfg);
  openPaper(a,q,{score:.8},risk,t,cfg);

  assert.equal(evaluateExit(a,q,-.9,t+5000,cfg),null,"minimum hold blocks early flip");
  assert.equal(a.position.flipConfirmations,0);
  assert.equal(evaluateExit(a,q,-.29,t+31000,cfg),null,"weak opposite consensus does not count");
  assert.equal(a.position.flipConfirmations,0);
  assert.equal(evaluateExit(a,q,-.31,t+32000,cfg),null);
  assert.equal(a.position.flipConfirmations,1);
  assert.equal(evaluateExit(a,q,-.45,t+33000,cfg),null);
  assert.equal(a.position.flipConfirmations,2);
  assert.equal(evaluateExit(a,q,-.50,t+34000,cfg),"confirmed consensus flip");
});

test("flip confirmation resets when opposite consensus does not persist",()=>{
  const cfg={...DEFAULT_CONFIG,minHoldMs:0,exitFlipThreshold:.30,exitFlipConfirmations:3};
  const a=createAccount(cfg),t=100000,q=quote(100,100.02,{receivedAt:t});
  const risk=riskDecision(a,q,{score:.8},t,cfg);
  openPaper(a,q,{score:.8},risk,t,cfg);
  assert.equal(evaluateExit(a,q,-.5,t+1000,cfg),null);
  assert.equal(a.position.flipConfirmations,1);
  assert.equal(evaluateExit(a,q,.1,t+2000,cfg),null);
  assert.equal(a.position.flipConfirmations,0);
});

test("risk stop bypasses anti-churn minimum hold",()=>{
  const cfg={...DEFAULT_CONFIG,minHoldMs:30000,exitFlipThreshold:.30,exitFlipConfirmations:3};
  const a=createAccount(cfg),t=100000,q=quote(100,100.02,{receivedAt:t});
  const risk=riskDecision(a,q,{score:.8},t,cfg);
  openPaper(a,q,{score:.8},risk,t,cfg);
  const down=quote(98.9,98.92,{receivedAt:t+1000});
  assert.equal(evaluateExit(a,down,.8,t+1000,cfg),"risk stop");
});
