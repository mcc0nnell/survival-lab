import test from "node:test";
import assert from "node:assert/strict";
import {validateManifest,normalizeTarget,createCartridge} from "../dist/cartridge.js";
import {createConsensusSix,createTimeSeriesMomentum,STRATEGY_REGISTRY,RESEARCH_CARTRIDGES} from "../dist/strategies.js";

const quote=(last,extra={})=>({
  source:"TEST",product:"BTC-USD",bid:last-.01,ask:last+.01,last,
  bidSize:2,askSize:1,aggressor:1,receivedAt:Date.now(),...extra
});

test("cartridge manifest declares universe, cadence and output",()=>{
  const c=createConsensusSix();
  assert.equal(c.manifest.id,"consensus-six");
  assert.deepEqual(c.manifest.universe,["BTC-USD"]);
  assert.equal(c.manifest.sampling,"1s");
  assert.equal(c.manifest.output,"target_exposure");
});

test("Consensus Six emits a normalized target with transparent explanation",()=>{
  const c=createConsensusSix();
  for(let i=0;i<20;i++)c.observe(quote(100+i*.1,{sequence:i}));
  const t=c.target();
  assert.equal(t.strategy_id,"consensus-six");
  assert.ok(t.exposure>=-1&&t.exposure<=1);
  assert.equal(t.score,t.exposure);
  assert.equal(t.explanation.signals.length,6);
  assert.ok(t.explanation.signals.every(s=>s.id&&Number.isFinite(s.raw)&&s.reason));
});

test("target contract rejects exposure outside [-1,1]",()=>{
  const manifest=validateManifest({
    id:"bad",name:"Bad",version:"1",universe:["BTC-USD"],
    sampling:"1s",rebalance:"1s",output:"target_exposure"
  });
  assert.throws(()=>normalizeTarget({exposure:1.1},manifest),RangeError);
});

test("cartridge keeps strategy state behind observe/target boundary",()=>{
  const c=createCartridge({
    manifest:{id:"counter",name:"Counter",version:"1",universe:["X"],sampling:"1s",rebalance:"1s",output:"target_exposure"},
    createState:()=>({n:0}),
    observe:s=>{s.n++},
    target:s=>({exposure:Math.min(1,s.n/10),rationale:"counted observations"})
  });
  c.observe({});c.observe({});
  assert.equal(c.target().exposure,.2);
  c.reset();
  assert.equal(c.target().exposure,0);
});

test("research archive entries are registered but cannot execute accidentally",()=>{
  assert.ok(RESEARCH_CARTRIDGES.length>=6);
  for(const item of RESEARCH_CARTRIDGES){
    const entry=STRATEGY_REGISTRY[item.id];
    assert.equal(entry.manifest.status,"research");
    assert.equal(entry.create,null);
  }
});

test("12-month TSMOM stays flat until its declared history is complete",()=>{
  const c=createTimeSeriesMomentum();
  for(let i=0;i<11;i++)c.observe({excessReturn:.01,exAnteVol:.20,receivedAt:i});
  assert.equal(c.target().exposure,0);
  assert.equal(c.target().explanation.observations,11);
});

test("12-month TSMOM follows own-return sign and exposes requested vol scale",()=>{
  const c=createTimeSeriesMomentum();
  for(let i=0;i<12;i++)c.observe({excessReturn:.01,exAnteVol:.20,receivedAt:i});
  const up=c.target();
  assert.equal(up.exposure,1);
  assert.ok(up.explanation.trailing_12m_excess_return>0);
  assert.equal(up.explanation.requested_leverage,2);
  const d=createTimeSeriesMomentum();
  for(let i=0;i<12;i++)d.observe({excessReturn:-.01,exAnteVol:.80,receivedAt:i});
  const down=d.target();
  assert.equal(down.exposure,-.5);
  assert.ok(down.explanation.trailing_12m_excess_return<0);
});
