#!/usr/bin/env node
// Local, read-only, paper replay; consumes external Kronos forecast receipts.
import {readFileSync} from "node:fs";
import {createKronosShadow,KRONOS_SHADOW_MANIFEST} from "../dist/kronos.js";
import {runDailyReplay} from "../dist/backtest.js";

const [historyPath,receiptsPath]=process.argv.slice(2);
if(!historyPath||!receiptsPath){
  console.error("usage: node scripts/kronos-shadow.mjs history.json receipts.json");
  process.exit(2);
}
const history=JSON.parse(readFileSync(historyPath,"utf8"));
const receipts=JSON.parse(readFileSync(receiptsPath,"utf8"));
if(history.id!=="btc-usd-spot-1d"||!Array.isArray(history.observations)||!Array.isArray(receipts)){
  throw new TypeError("expected BTC-USD daily history object and receipts array");
}
const results=runDailyReplay({
  id:KRONOS_SHADOW_MANIFEST.id,name:KRONOS_SHADOW_MANIFEST.name,
  create:()=>createKronosShadow({receipts}),dataset:history,evaluationDays:365,costBps:21.5
});
console.log(JSON.stringify({paper_only:true,model_validated_profitable:false,receipt_count:receipts.length,
  ...Object.fromEntries(["total_return","annualized_return","max_drawdown","sharpe","turnover","observations"].map(k=>[k,results[k]]))},null,2));
