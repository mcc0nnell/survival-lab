import test from "node:test";
import assert from "node:assert/strict";
import {
  BUY_HOLD_MANIFEST,SMA_CROSS_MANIFEST,DONCHIAN_MANIFEST,RSI_MANIFEST,
  createBuyHold,createSmaCross,createDonchian,createRsiReversion,STRATEGY_REGISTRY
} from "../dist/strategies.js";
import {HISTORY_DATASETS,compatibility,bootstrapStrategy,dailyOhlcvObservations} from "../dist/history.js";

const bar=(close,{high=close+1,low=close-1,receivedAt=Date.now()}={})=>({open:close,high,low,close,volume:1,receivedAt});

function spotPlane(rows){
  const spec=HISTORY_DATASETS["btc-usd-spot-1d"];
  const observations=rows.map((r,i)=>({observed_at:new Date(Date.UTC(2025,0,1+i)).toISOString(),open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume}));
  const dataset={...spec,contract:spec.contract,count:observations.length,observations};
  return {datasets:new Map([[spec.id,dataset]]),get:id=>id===spec.id?dataset:null};
}

test("new replay cartridges are executable and declare the existing spot history plane",()=>{
  for(const manifest of [BUY_HOLD_MANIFEST,SMA_CROSS_MANIFEST,DONCHIAN_MANIFEST,RSI_MANIFEST]){
    const entry=STRATEGY_REGISTRY[manifest.id];
    assert.equal(typeof entry.create,"function");
    assert.equal(manifest.status,"replay");
    assert.equal(manifest.history_contract.dataset_id,"btc-usd-spot-1d");
    assert.equal(manifest.history_contract.adapter,"daily-ohlcv-v1");
  }
});

test("daily OHLC adapter normalizes numeric fields and timestamps",()=>{
  const rows=[{observed_at:"2026-01-01T00:00:00Z",open:"99",high:"101",low:"98",close:"100",volume:"3"}];
  assert.deepEqual(dailyOhlcvObservations(rows),[{open:99,high:101,low:98,close:100,volume:3,receivedAt:Date.parse(rows[0].observed_at),observed_at:rows[0].observed_at}]);
});

test("buy-and-hold is a constant long benchmark after one observation",()=>{
  const c=createBuyHold();
  assert.equal(c.target().exposure,0);
  c.observe(bar(100));
  assert.equal(c.target().exposure,1);
  assert.equal(c.target().explanation.benchmark,true);
});

test("SMA 50/200 follows the sign of the moving-average spread",()=>{
  const up=createSmaCross();
  for(let i=0;i<200;i++)up.observe(bar(100+i));
  assert.equal(up.target().exposure,1);
  assert.ok(up.target().explanation.sma_50>up.target().explanation.sma_200);
  const down=createSmaCross();
  for(let i=0;i<200;i++)down.observe(bar(300-i));
  assert.equal(down.target().exposure,-1);
});

test("Donchian waits for 55 prior bars, then enters only on a fresh breakout",()=>{
  const c=createDonchian();
  for(let i=0;i<55;i++)c.observe(bar(100,{high:101,low:99,receivedAt:i}));
  assert.equal(c.target().exposure,0);
  c.observe(bar(102,{high:103,low:101,receivedAt:56}));
  assert.equal(c.target().exposure,1);
  assert.match(c.target().rationale,/upside breakout/);
});

test("RSI-14 mean reversion goes long after persistent losses and short after persistent gains",()=>{
  const down=createRsiReversion();
  for(let i=0;i<15;i++)down.observe(bar(100-i));
  assert.equal(down.target().exposure,1);
  assert.equal(down.target().explanation.rsi_14,0);
  const up=createRsiReversion();
  for(let i=0;i<15;i++)up.observe(bar(100+i));
  assert.equal(up.target().exposure,-1);
  assert.equal(up.target().explanation.rsi_14,100);
});

test("all new cartridges bootstrap from one cached spot dataset",()=>{
  const rows=Array.from({length:430},(_,i)=>bar(100+i*.2+Math.sin(i/10),{high:101+i*.2+Math.sin(i/10),low:99+i*.2+Math.sin(i/10),receivedAt:i}));
  const plane=spotPlane(rows);
  for(const create of [createBuyHold,createSmaCross,createDonchian,createRsiReversion]){
    const strategy=create();
    assert.equal(compatibility(strategy.manifest,plane).state,"READY");
    const boot=bootstrapStrategy(strategy,plane);
    assert.equal(boot.ready,true);
    assert.equal(boot.count,430);
    assert.equal(boot.target.strategy_id,strategy.manifest.id);
  }
});
