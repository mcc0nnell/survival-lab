import fs from "node:fs";
import {runCompounderRace} from "../dist/backtest.js";
import {createDonchian4510,createDonchian,createSmaCross,createRsiReversion} from "../dist/strategies.js";

function historyEndpoint(){
  if(process.env.SURVIVAL_HISTORY_ENDPOINT)return process.env.SURVIVAL_HISTORY_ENDPOINT;
  const html=fs.readFileSync(new URL("../dist/index.html",import.meta.url),"utf8");
  const match=html.match(/name="survival-evidence-endpoint"\s+content="([^"]+)"/);
  if(!match)throw new Error("survival evidence endpoint is not configured");
  return match[1].replace(/\/api\/events$/,"/api/history");
}

async function loadHistory(days=730){
  const u=new URL(historyEndpoint());
  u.searchParams.set("product","BTC-USD");
  u.searchParams.set("cadence","1d");
  u.searchParams.set("days",String(days));
  const res=await fetch(u,{headers:{Origin:"https://trader.mcc0nnell.org"},cache:"no-store"});
  if(!res.ok)throw new Error("history HTTP "+res.status);
  const data=await res.json();
  return {...data,id:"btc-usd-spot-1d",cadence:"1d",contract:{kind:"ohlcv",price_type:"spot"}};
}

const dataset=await loadHistory();
console.log("History:",dataset.count,dataset.observations?.[0]?.observed_at,"→",dataset.observations?.at(-1)?.observed_at);

const defs=[
  ["donchian-45-10","Donchian 45/10",createDonchian4510],
  ["donchian-55-20","Donchian 55/20",createDonchian],
  ["sma-50-200","SMA 50/200",createSmaCross],
  ["rsi-14-reversion","RSI-14",createRsiReversion]
];

for(const [id,name,create] of defs){
  const race=runCompounderRace({id,name,create,dataset,evaluationDays:365,costBps:21.5});
  console.log("\n"+name);
  console.table(race.results.map(x=>({
    compounder:x.compounder_id||"control",
    total_return_pct:+(x.total_return*100).toFixed(2),
    annualized_pct:+(x.annualized_return*100).toFixed(2),
    max_dd_pct:+(x.max_drawdown*100).toFixed(2),
    sharpe:x.sharpe==null?null:+x.sharpe.toFixed(2),
    calmar:x.calmar==null?null:+x.calmar.toFixed(2),
    turnover:+x.turnover.toFixed(2)
  })));
}
