import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, createAccount, computeSignals, consensus,
  markAccount, riskDecision, openPaper, closePaper, enforceKillSwitch
} from "../dist/core.js";

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
