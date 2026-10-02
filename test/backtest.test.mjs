import test from "node:test";
import assert from "node:assert/strict";
import {createCartridge} from "../dist/cartridge.js";
import {runDailyReplay,runHistoricalTournament} from "../dist/backtest.js";

function dataset(id,n,fn){
  const start=Date.UTC(2024,0,1);
  return {id,count:n,observations:Array.from({length:n},(_,i)=>{
    const close=fn(i);
    return {observed_at:new Date(start+i*86400000).toISOString(),open:close,high:close*1.01,low:close*.99,close,volume:1};
  })};
}

test("daily replay uses prior exposure, not the current bar signal",()=>{
  const create=()=>createCartridge({
    manifest:{id:"lag-test",name:"Lag Test",version:"1",universe:["X"],sampling:"1d",rebalance:"1d",output:"target_exposure"},
    createState:()=>({last:0}),
    observe:(s,o)=>{s.last=o.close},
    target:s=>({exposure:s.last>=200?1:0})
  });
  const d=dataset("x",3,i=>[100,200,100][i]);
  const r=runDailyReplay({id:"lag-test",name:"Lag Test",create,dataset:d,evaluationDays:2,costBps:0});
  assert.equal(r.curve[1].equity,1);
  assert.equal(r.curve[2].equity,.5);
});

test("turnover friction is charged when target exposure changes",()=>{
  const create=()=>createCartridge({
    manifest:{id:"flip",name:"Flip",version:"1",universe:["X"],sampling:"1d",rebalance:"1d",output:"target_exposure"},
    createState:()=>({n:0}),observe:s=>{s.n++},target:s=>({exposure:s.n%2?1:-1})
  });
  const d=dataset("x",5,()=>100);
  const r=runDailyReplay({id:"flip",name:"Flip",create,dataset:d,evaluationDays:3,costBps:100});
  assert.equal(r.turnover,6);
  assert.ok(r.total_return<0);
});

test("historical tournament returns all five replay cartridges with benchmark-relative metrics",()=>{
  const spot=dataset("btc-usd-spot-1d",730,i=>100*Math.exp(.0007*i+.04*Math.sin(i/19)));
  const futures=dataset("kraken-pf-xbtusd-1d",730,i=>100*Math.exp(.0005*i+.03*Math.sin(i/23)));
  const t=runHistoricalTournament({spotDataset:spot,futuresDataset:futures,evaluationDays:365,costBps:21.5});
  assert.equal(t.results.length,5);
  assert.deepEqual(new Set(t.results.map(x=>x.id)),new Set(["btc-buy-hold","sma-50-200","donchian-55-20","rsi-14-reversion","tsmom-12m"]));
  for(const r of t.results){
    assert.ok(Number.isFinite(r.total_return));
    assert.ok(Number.isFinite(r.max_drawdown));
    assert.ok(Number.isFinite(r.turnover));
    assert.ok(Number.isFinite(r.relative_return));
    assert.ok(r.curve.length>1);
  }
});
