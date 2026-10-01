import test from "node:test";
import assert from "node:assert/strict";
import {aggregateMonthlySpot,compatibility,HISTORY_DATASETS,ewmaAnnualizedVol,tsmomObservationsFromDaily,bootstrapStrategy} from "../dist/history.js";
import {CONSENSUS_SIX_MANIFEST,TSMOM_MANIFEST,createTimeSeriesMomentum} from "../dist/strategies.js";

test("monthly aggregation uses the final close in each UTC month",()=>{
  const rows=[
    {observed_at:"2026-01-01T00:00:00Z",close:100},
    {observed_at:"2026-01-31T00:00:00Z",close:110},
    {observed_at:"2026-02-10T00:00:00Z",close:121},
    {observed_at:"2026-02-28T00:00:00Z",close:120}
  ];
  const m=aggregateMonthlySpot(rows);
  assert.equal(m.length,2);
  assert.equal(m[0].close,110);
  assert.equal(m[1].close,120);
  assert.ok(Math.abs(m[1].return-(120/110-1))<1e-12);
});

test("Consensus Six is history-independent",()=>{
  assert.deepEqual(compatibility(CONSENSUS_SIX_MANIFEST,null),{
    state:"ACTIVE",reason:"no historical bootstrap required"
  });
});

test("TSMOM rejects a spot dataset with the wrong dataset identity",()=>{
  const spec=HISTORY_DATASETS["btc-usd-spot-1d"];
  const dataset={...spec,contract:spec.contract,count:430,observations:[]};
  const c=compatibility(TSMOM_MANIFEST,dataset);
  assert.equal(c.state,"BLOCKED");
  assert.match(c.reason,/kraken-pf-xbtusd-1d unavailable/);
});

test("TSMOM accepts its declared futures history contract",()=>{
  const spec=HISTORY_DATASETS["kraken-pf-xbtusd-1d"];
  const dataset={...spec,contract:spec.contract,count:430,observations:[]};
  const plane={datasets:new Map([[spec.id,dataset]])};
  assert.deepEqual(compatibility(TSMOM_MANIFEST,plane),{
    state:"READY",reason:"history contract satisfied"
  });
});

test("EWMA ex-ante volatility is finite and positive on moving futures prices",()=>{
  const start=Date.UTC(2025,0,1);
  const rows=Array.from({length:180},(_,i)=>({
    observed_at:new Date(start+i*86400000).toISOString(),
    close:100*Math.exp(.0004*i+.01*Math.sin(i/7))
  }));
  const vol=ewmaAnnualizedVol(rows);
  assert.ok(Number.isFinite(vol));
  assert.ok(vol>0);
});

test("TSMOM history adapter produces 12 monthly observations and bootstraps a target",()=>{
  const start=Date.UTC(2025,0,1);
  const rows=Array.from({length:430},(_,i)=>({
    observed_at:new Date(start+i*86400000).toISOString(),
    open:100+i*.15,high:101+i*.15,low:99+i*.15,close:100+i*.15,volume:1
  }));
  const observations=tsmomObservationsFromDaily(rows);
  assert.equal(observations.length,12);
  assert.ok(observations.every(x=>Number.isFinite(x.excessReturn)&&x.exAnteVol>0));
  const spec=HISTORY_DATASETS["kraken-pf-xbtusd-1d"];
  const dataset={...spec,contract:spec.contract,count:rows.length,observations:rows};
  const plane={datasets:new Map([[spec.id,dataset]]),get:id=>id===spec.id?dataset:null};
  const strategy=createTimeSeriesMomentum();
  const boot=bootstrapStrategy(strategy,plane);
  assert.equal(boot.ready,true);
  assert.equal(boot.count,12);
  assert.equal(boot.target.strategy_id,"tsmom-12m");
  assert.ok(boot.target.exposure>0);
});
