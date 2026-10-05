import test from "node:test";
import assert from "node:assert/strict";
import {createCartridge} from "../dist/cartridge.js";
import {
  createFixedFractionalCompounder,
  createVolTargetCompounder,
  createFractionalKellyCompounder,
  createHybridCompounder
} from "../dist/compounder.js";
import {runCompounderRace} from "../dist/backtest.js";

function dataset(n,fn){
  const start=Date.UTC(2024,0,1);
  return {id:"btc-usd-spot-1d",count:n,observations:Array.from({length:n},(_,i)=>{
    const close=fn(i);
    return {observed_at:new Date(start+i*86400000).toISOString(),open:close,high:close*1.01,low:close*.99,close,volume:1};
  })};
}

function createAlwaysLong(){
  return createCartridge({
    manifest:{id:"always-long",name:"Always Long",version:"1",universe:["X"],sampling:"1d",rebalance:"1d",output:"target_exposure"},
    createState:()=>({seen:false,last:null}),
    observe:(s,o)=>{s.seen=true;s.last=o},
    target:s=>({exposure:s.seen?1:0})
  });
}

test("fixed fractional sizes the raw target without leverage",()=>{
  const c=createFixedFractionalCompounder({fraction:.75});
  assert.equal(c.next({rawExposure:1}).exposure,.75);
  assert.equal(c.next({rawExposure:-1}).exposure,-.75);
});

test("hybrid compounder throttles exposure as drawdown deepens",()=>{
  const c=createHybridCompounder({drawdownStart:.05,drawdownFull:.15,minFraction:.25,noTradeBand:0});
  c.reset({equity:1});
  assert.equal(c.next({rawExposure:1,equity:1,previousExposure:0}).exposure,1);
  const mid=c.next({rawExposure:1,equity:.90,previousExposure:1});
  assert.ok(mid.exposure<1&&mid.exposure>.25);
  assert.equal(c.next({rawExposure:1,equity:.80,previousExposure:mid.exposure}).exposure,.25);
});

test("vol target and Kelly stay inside the common normalized exposure boundary",()=>{
  const vol=createVolTargetCompounder({targetVol:.20,lookback:5,minScale:.1});
  const kelly=createFractionalKellyCompounder({minSamples:3,lookback:5});
  let v=0,k=0;
  for(const r of [.03,-.02,.04,-.01,.05]){
    v=vol.next({rawExposure:1,assetReturn:r,previousExposure:v}).exposure;
    k=kelly.next({rawExposure:1,signalReturn:r,previousExposure:k}).exposure;
    assert.ok(v>=0&&v<=1);
    assert.ok(k>=0&&k<=1);
  }
});

test("compounder race preserves a raw control and reports geometric metrics",()=>{
  const d=dataset(430,i=>100*Math.exp(.0008*i+.06*Math.sin(i/17)));
  const race=runCompounderRace({id:"always-long",name:"Always Long",create:createAlwaysLong,dataset:d,evaluationDays:365,costBps:21.5});
  assert.equal(race.results.length,5);
  assert.equal(race.results[0].compounder_id,null);
  assert.deepEqual(new Set(race.results.slice(1).map(x=>x.compounder_id)),new Set([
    "fixed-fractional","vol-target","quarter-kelly","hybrid-fractional-drawdown-band"
  ]));
  for(const result of race.results){
    assert.ok(Number.isFinite(result.total_return));
    assert.ok(Number.isFinite(result.annualized_return));
    assert.ok(Number.isFinite(result.max_drawdown));
    assert.ok(result.curve.length>1);
  }
});
