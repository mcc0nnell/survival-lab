export const HISTORY_DATASETS=Object.freeze({
  "btc-usd-spot-1d":Object.freeze({
    id:"btc-usd-spot-1d",provider:"kraken-spot",product:"BTC-USD",cadence:"1d",
    contract:Object.freeze({kind:"ohlcv",price_type:"spot",fields:["open","high","low","close","volume"]})
  }),
  "kraken-pf-xbtusd-1d":Object.freeze({
    id:"kraken-pf-xbtusd-1d",provider:"kraken-futures",product:"PF_XBTUSD",cadence:"1d",
    contract:Object.freeze({kind:"ohlcv",price_type:"perpetual_futures",fields:["open","high","low","close","volume"]})
  })
});

export class HistoryPlane{
  constructor({endpoint}={}){this.endpoint=endpoint;this.datasets=new Map()}
  async load(id="btc-usd-spot-1d",{days=430}={}){
    const spec=HISTORY_DATASETS[id];
    if(!spec)throw new Error("unknown history dataset: "+id);
    if(!this.endpoint)throw new Error("history endpoint unavailable");
    const u=new URL(this.endpoint);
    u.searchParams.set("product",spec.product);
    u.searchParams.set("cadence",spec.cadence);
    u.searchParams.set("days",String(days));
    const res=await fetch(u,{cache:"no-store"});
    if(!res.ok)throw new Error("history HTTP "+res.status);
    const data=await res.json();
    const dataset=Object.freeze({...data,id,spec});
    this.datasets.set(id,dataset);
    return dataset;
  }
  get(id){return this.datasets.get(id)||null}
}

export function aggregateMonthly(daily){
  const byMonth=new Map();
  for(const row of daily||[]){
    const t=new Date(row.observed_at);
    if(!Number.isFinite(t.getTime()))continue;
    const key=t.getUTCFullYear()+"-"+String(t.getUTCMonth()+1).padStart(2,"0");
    const prev=byMonth.get(key);
    if(!prev||new Date(row.observed_at)>new Date(prev.observed_at))byMonth.set(key,row);
  }
  const closes=[...byMonth.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([month,row])=>({month,close:Number(row.close),observed_at:row.observed_at}));
  return closes.map((x,i)=>({...x,return:i&&closes[i-1].close?x.close/closes[i-1].close-1:null}));
}
export const aggregateMonthlySpot=aggregateMonthly;

export function ewmaAnnualizedVol(daily,{centerDays=60,annualDays=261}={}){
  const closes=(daily||[]).map(x=>Number(x.close)).filter(Number.isFinite);
  if(closes.length<3)return null;
  const rs=[];
  for(let i=1;i<closes.length;i++)if(closes[i-1]>0&&closes[i]>0)rs.push(closes[i]/closes[i-1]-1);
  if(rs.length<2)return null;
  const delta=centerDays/(centerDays+1);
  let weightSum=0,mean=0;
  for(let i=0;i<rs.length;i++){
    const w=(1-delta)*Math.pow(delta,i),r=rs[rs.length-1-i];
    weightSum+=w;mean+=w*r;
  }
  if(weightSum<=0)return null;
  mean/=weightSum;
  let variance=0;
  for(let i=0;i<rs.length;i++){
    const w=(1-delta)*Math.pow(delta,i),r=rs[rs.length-1-i];
    variance+=w*(r-mean)*(r-mean);
  }
  variance/=weightSum;
  return Math.sqrt(Math.max(0,annualDays*variance));
}

export function tsmomObservationsFromDaily(daily){
  const monthly=aggregateMonthly(daily).filter(x=>Number.isFinite(x.return));
  if(monthly.length<12)return [];
  const selected=monthly.slice(-12);
  return selected.map(m=>{
    const cutoff=new Date(m.observed_at).getTime();
    const prior=(daily||[]).filter(x=>new Date(x.observed_at).getTime()<=cutoff);
    return {
      excessReturn:m.return,
      exAnteVol:ewmaAnnualizedVol(prior),
      receivedAt:cutoff,
      month:m.month
    };
  }).filter(x=>Number.isFinite(x.exAnteVol)&&x.exAnteVol>0);
}

function resolveDataset(need,input){
  if(!need)return null;
  if(input instanceof Map)return input.get(need.dataset_id)||null;
  if(input?.datasets instanceof Map)return input.datasets.get(need.dataset_id)||null;
  if(input?.id===need.dataset_id)return input;
  return null;
}

export function compatibility(manifest,input){
  const need=manifest?.history_contract;
  if(!need)return {state:manifest?.status==="active"?"ACTIVE":"READY",reason:"no historical bootstrap required"};
  const dataset=resolveDataset(need,input);
  if(!dataset)return {state:"BLOCKED",reason:"history dataset "+need.dataset_id+" unavailable"};
  const have=dataset.contract||dataset.spec?.contract||{};
  const reasons=[];
  if(need.kind&&have.kind!==need.kind)reasons.push("needs "+need.kind+", has "+(have.kind||"unknown"));
  if(need.price_type&&have.price_type!==need.price_type)reasons.push("needs "+need.price_type+", has "+(have.price_type||"unknown"));
  if(need.cadence&&dataset.cadence!==need.cadence)reasons.push("needs "+need.cadence+", has "+(dataset.cadence||"unknown"));
  if(need.min_observations&&Number(dataset.count||0)<need.min_observations)reasons.push("needs "+need.min_observations+" observations");
  return reasons.length?{state:"BLOCKED",reason:reasons.join("; ")}:{state:"READY",reason:"history contract satisfied"};
}

export function bootstrapStrategy(strategy,plane){
  const need=strategy?.manifest?.history_contract;
  if(!need)return {ready:true,count:0,target:strategy.target()};
  const dataset=plane.get(need.dataset_id);
  const c=compatibility(strategy.manifest,plane);
  if(c.state!=="READY")return {ready:false,count:0,reason:c.reason,target:null};
  let observations;
  if(need.adapter==="tsmom-12m-v1")observations=tsmomObservationsFromDaily(dataset.observations);
  else throw new Error("unknown history adapter: "+need.adapter);
  strategy.reset();
  for(const observation of observations)strategy.observe(observation);
  return {ready:observations.length>=12,count:observations.length,target:strategy.target(),reason:"bootstrapped from "+need.dataset_id};
}
