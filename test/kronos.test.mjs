import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createKronosShadow,validateKronosReceipt,KRONOS_SHADOW_MANIFEST} from "../dist/kronos.js";
import {STRATEGY_REGISTRY,createStrategy} from "../dist/strategies.js";
import {runDailyReplay} from "../dist/backtest.js";

const day=i=>new Date(Date.UTC(2026,0,1+i)).toISOString();
const rev="901c26c1332695a2a8f243eb2f37243a37bea320";
const tok="0e0117387f39004a9016484a186a908917e22426";
function receipt(i,inputClose,closes=[200,201,202,203,204,205,206,207]){
  return {schema_version:1,source:"kronos-inference",dataset_id:"btc-usd-spot-1d",
    model_id:"NeoQuasar/Kronos-small",model_revision:rev,tokenizer_revision:tok,
    input_digest:"a".repeat(64),input_count:3,input_close:inputClose,
    as_of:day(i),input_last_at:day(i),forecast_for:day(i+1),generated_at:"2026-10-21T20:00:00.000Z",
    scenario_closes:closes,seed:123,temperature:1,top_p:.9,execution_allowed:false,validation_status:"UNVERIFIED_CHECKPOINT_HISTORY"};
}
const row=(i,close)=>({observed_at:day(i),open:close,high:close+1,low:close-1,close,volume:2});
const bar=(i,close)=>({receivedAt:Date.parse(day(i)),open:close,high:close+1,low:close-1,close,volume:2});

test("Kronos is cataloged but intentionally not executable through live strategy registry",()=>{
  assert.equal(STRATEGY_REGISTRY[KRONOS_SHADOW_MANIFEST.id].create,null);
  assert.equal(KRONOS_SHADOW_MANIFEST.status,"research");
  assert.throws(()=>createStrategy(KRONOS_SHADOW_MANIFEST.id),/research-only/);
});

test("forecast receipts require pinned model, exact next bar, shape, and input provenance",()=>{
  const valid=receipt(2,100);
  assert.equal(validateKronosReceipt(valid).scenario_closes.length,8);
  assert.throws(()=>validateKronosReceipt({...valid,model_id:"other"}),/provenance/);
  assert.throws(()=>validateKronosReceipt({...valid,model_revision:"b".repeat(40)}),/pinned/);
  assert.throws(()=>validateKronosReceipt({...valid,execution_allowed:true}),/prohibit execution/);
  assert.throws(()=>validateKronosReceipt({...valid,forecast_for:day(2)}),/time bounds/);
  assert.throws(()=>validateKronosReceipt({...valid,input_last_at:day(1)}),/time bounds/);
  assert.throws(()=>validateKronosReceipt({...valid,scenario_closes:[NaN,100]}),/scenarios/);
  assert.throws(()=>validateKronosReceipt({...valid,input_digest:"missing"}),/digest/);
  assert.throws(()=>validateKronosReceipt({...valid,generated_at:day(0)}),/time bounds/);
  assert.throws(()=>createKronosShadow({receipts:[valid,valid]}),/duplicate/);
});

test("unmatched forecasts stay flat; matching receipts use next-bar-only targets",()=>{
  const r=receipt(2,100);
  const c=createKronosShadow({receipts:[r]});
  c.observe(bar(0,100)); assert.equal(c.target().exposure,0);
  c.observe(bar(1,200)); assert.equal(c.target().exposure,0);
  c.observe(bar(2,100)); assert.equal(c.target().exposure,.25);
  assert.equal(c.target().confidence,0); // uncalibrated
  assert.equal(c.target().explanation.paper_only,true);
  c.observe(bar(3,300)); assert.equal(c.target().exposure,0);
  c.reset();
  assert.equal(c.target().exposure,0);
  assert.equal(c.target().explanation.matched_receipts,0);
  assert.throws(()=>c.observe(bar(2,999)),/does not match replay close/);
});

test("replay charges tomorrow's return; no receipt cannot generate an edge",()=>{
  const history={id:"btc-usd-spot-1d",count:5,observations:[
    row(0,100),row(1,100),row(2,100),row(3,200),row(4,100)]};
  const create=()=>createKronosShadow({receipts:[receipt(2,100)]});
  const out=runDailyReplay({id:KRONOS_SHADOW_MANIFEST.id,name:KRONOS_SHADOW_MANIFEST.name,
    create,dataset:history,evaluationDays:3,costBps:0});
  assert.equal(out.curve[1].equity,1); // no same-bar position
  assert.equal(out.curve[2].equity,1.25); // t2 signal earns only t2->t3 return
  assert.equal(out.curve[3].equity,1.25); // missing t3 receipt => flat
  const none=runDailyReplay({id:"kronos",name:"Kronos",create:()=>createKronosShadow(),
    dataset:history,evaluationDays:3,costBps:21.5});
  assert.equal(none.total_return,0);
  assert.equal(none.turnover,0);
});

test("Python request validation works without torch or downloaded weights",t=>{
  const request={schema_version:1,dataset_id:"btc-usd-spot-1d",
    bars:[row(0,100),row(1,101),row(2,102)],
    as_of:day(2),forecast_for:day(3),scenario_count:8};
  const result=spawnSync("python3",["research/kronos/forecast.py","--validate"],{
    input:JSON.stringify(request),encoding:"utf8",timeout:5000});
  if(result.error?.code==="ENOENT"){t.skip("python3 not installed");return}
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.equal(data.inference_performed,false);
  assert.match(data.input_digest,/^[0-9a-f]{64}$/);
  request.bars.push(row(4,103)); // skipped future calendar bar
  request.as_of=day(4);request.forecast_for=day(5);
  const rejected=spawnSync("python3",["research/kronos/forecast.py","--validate"],{
    input:JSON.stringify(request),encoding:"utf8",timeout:5000});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/consecutive/);
});
