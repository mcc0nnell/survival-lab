import {dailyOhlcvObservations,aggregateMonthly,ewmaAnnualizedVol} from "./history.js";
import {createBuyHold,createSmaCross,createDonchian,createRsiReversion,createTimeSeriesMomentum} from "./strategies.js";

const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:0;

function stdev(xs){
  if(xs.length<2)return 0;
  const m=mean(xs);
  return Math.sqrt(xs.reduce((s,x)=>s+(x-m)*(x-m),0)/(xs.length-1));
}

function finalize({id,name,dataset,curve,periodReturns,turnover,annualPeriods,benchmarkId}){
  const totalReturn=(curve.at(-1)?.equity??1)-1;
  let peak=1,maxDrawdown=0;
  for(const point of curve){
    peak=Math.max(peak,point.equity);
    if(peak>0)maxDrawdown=Math.max(maxDrawdown,(peak-point.equity)/peak);
  }
  const sd=stdev(periodReturns);
  const sharpe=sd>0?mean(periodReturns)/sd*Math.sqrt(annualPeriods):null;
  return {id,name,dataset,total_return:totalReturn,max_drawdown:maxDrawdown,
    sharpe:Number.isFinite(sharpe)?sharpe:null,turnover,observations:periodReturns.length,
    benchmark_id:benchmarkId,curve};
}

function sortedDaily(dataset){
  return dailyOhlcvObservations(dataset?.observations||[]).sort((a,b)=>a.receivedAt-b.receivedAt);
}

export function runDailyReplay({id,name,create,dataset,evaluationDays=365,costBps=21.5,benchmarkId="btc-buy-hold"}){
  const rows=sortedDaily(dataset);
  if(rows.length<3)throw new Error(id+" needs daily history");
  const evalIndex=Math.max(1,rows.length-Math.max(2,evaluationDays));
  const strategy=create();
  let exposure=0;
  for(let i=0;i<evalIndex;i++){
    strategy.observe(rows[i]);
    exposure=Number(strategy.target().exposure)||0;
  }
  let equity=1,turnover=0,previousClose=rows[evalIndex-1].close;
  const curve=[{at:rows[evalIndex-1].observed_at,equity}],periodReturns=[];
  const costRate=Math.max(0,Number(costBps)||0)/10000;
  for(let i=evalIndex;i<rows.length;i++){
    const observation=rows[i],startEquity=equity;
    const assetReturn=previousClose>0?observation.close/previousClose-1:0;
    equity*=Math.max(0,1+exposure*assetReturn);
    strategy.observe(observation);
    const nextExposure=Number(strategy.target().exposure);
    if(!Number.isFinite(nextExposure)||nextExposure<-1||nextExposure>1)throw new RangeError(id+" emitted invalid exposure");
    const change=Math.abs(nextExposure-exposure);
    if(change){
      turnover+=change;
      equity*=Math.max(0,1-change*costRate);
    }
    periodReturns.push(startEquity>0?equity/startEquity-1:0);
    curve.push({at:observation.observed_at,equity});
    exposure=nextExposure;
    previousClose=observation.close;
  }
  return finalize({id,name,dataset:dataset.id,curve,periodReturns,turnover,annualPeriods:365,benchmarkId});
}

function monthlyObservations(dataset){
  const daily=(dataset?.observations||[]).slice().sort((a,b)=>new Date(a.observed_at)-new Date(b.observed_at));
  const monthly=aggregateMonthly(daily).filter(x=>Number.isFinite(x.return));
  return monthly.map(m=>{
    const cutoff=new Date(m.observed_at).getTime();
    const prior=daily.filter(x=>new Date(x.observed_at).getTime()<=cutoff);
    return {...m,receivedAt:cutoff,exAnteVol:ewmaAnnualizedVol(prior)};
  }).filter(x=>Number.isFinite(x.exAnteVol)&&x.exAnteVol>0);
}

export function runTsmomReplay({dataset,evaluationDays=365,costBps=21.5}){
  const months=monthlyObservations(dataset);
  const evaluationMonths=Math.max(1,Math.round(evaluationDays/30.4375));
  const evalIndex=Math.max(12,months.length-evaluationMonths);
  if(months.length<=evalIndex)throw new Error("tsmom-12m needs a warmup plus evaluation window");
  const strategy=createTimeSeriesMomentum();
  let exposure=0;
  for(let i=0;i<evalIndex;i++){
    const m=months[i];
    strategy.observe({excessReturn:m.return,exAnteVol:m.exAnteVol,receivedAt:m.receivedAt,month:m.month});
    exposure=Number(strategy.target().exposure)||0;
  }
  let equity=1,turnover=0;
  const costRate=Math.max(0,Number(costBps)||0)/10000;
  const curve=[{at:months[evalIndex-1].observed_at,equity}],periodReturns=[];
  for(let i=evalIndex;i<months.length;i++){
    const m=months[i],startEquity=equity;
    equity*=Math.max(0,1+exposure*m.return);
    strategy.observe({excessReturn:m.return,exAnteVol:m.exAnteVol,receivedAt:m.receivedAt,month:m.month});
    const nextExposure=Number(strategy.target().exposure);
    if(!Number.isFinite(nextExposure)||nextExposure<-1||nextExposure>1)throw new RangeError("tsmom-12m emitted invalid exposure");
    const change=Math.abs(nextExposure-exposure);
    if(change){
      turnover+=change;
      equity*=Math.max(0,1-change*costRate);
    }
    periodReturns.push(startEquity>0?equity/startEquity-1:0);
    curve.push({at:m.observed_at,equity});
    exposure=nextExposure;
  }
  return finalize({id:"tsmom-12m",name:"Time-Series Momentum 12M",dataset:dataset.id,curve,periodReturns,turnover,annualPeriods:12,benchmarkId:"futures-buy-hold"});
}

export function runFuturesBenchmark({dataset,evaluationDays=365}){
  const months=monthlyObservations(dataset);
  const evaluationMonths=Math.max(1,Math.round(evaluationDays/30.4375));
  const evalIndex=Math.max(1,months.length-evaluationMonths);
  if(months.length<=evalIndex)throw new Error("futures benchmark needs an evaluation window");
  let equity=1;
  const curve=[{at:months[evalIndex-1].observed_at,equity}],periodReturns=[];
  for(let i=evalIndex;i<months.length;i++){
    const startEquity=equity;
    equity*=Math.max(0,1+months[i].return);
    periodReturns.push(startEquity>0?equity/startEquity-1:0);
    curve.push({at:months[i].observed_at,equity});
  }
  return finalize({id:"futures-buy-hold",name:"PF_XBTUSD Buy & Hold",dataset:dataset.id,curve,periodReturns,turnover:0,annualPeriods:12,benchmarkId:"futures-buy-hold"});
}

export function runHistoricalTournament({spotDataset,futuresDataset,evaluationDays=365,costBps=21.5}){
  const spotDefs=[
    ["btc-buy-hold","BTC Buy & Hold",createBuyHold],
    ["sma-50-200","SMA 50 / 200 Trend",createSmaCross],
    ["donchian-55-20","Donchian 55 / 20 Breakout",createDonchian],
    ["rsi-14-reversion","RSI-14 Mean Reversion",createRsiReversion]
  ];
  const results=spotDefs.map(([id,name,create])=>runDailyReplay({id,name,create,dataset:spotDataset,evaluationDays,costBps,
    benchmarkId:"btc-buy-hold"}));
  const futuresBenchmark=runFuturesBenchmark({dataset:futuresDataset,evaluationDays});
  results.push(runTsmomReplay({dataset:futuresDataset,evaluationDays,costBps}));
  const benchmarks=new Map([
    ["btc-buy-hold",results.find(x=>x.id==="btc-buy-hold")],
    ["futures-buy-hold",futuresBenchmark]
  ]);
  for(const result of results){
    const benchmark=benchmarks.get(result.benchmark_id);
    result.benchmark_return=benchmark?.total_return??null;
    result.relative_return=benchmark?result.total_return-benchmark.total_return:null;
  }
  return {evaluation_days:evaluationDays,cost_bps:costBps,results,futures_benchmark:futuresBenchmark};
}
