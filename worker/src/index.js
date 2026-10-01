import { neon } from "@neondatabase/serverless";

const ALLOWED_KINDS=new Set(["run_start","run_end","decision","trade","hold","control","system"]);
const HISTORY_PRODUCTS=new Set(["BTC-USD","PF_XBTUSD"]);
const cors=origin=>({
  "content-type":"application/json",
  "access-control-allow-origin":origin||"*",
  "access-control-allow-methods":"GET,POST,OPTIONS",
  "access-control-allow-headers":"content-type"
});

function originAllowed(allowedOrigin,requestOrigin){
  return allowedOrigin==="*"||!requestOrigin||requestOrigin===allowedOrigin;
}
const isoDay=d=>new Date(d).toISOString();

async function readLedger(sql){
  const runs=await sql`
    WITH recent AS (
      SELECT run_id,min(occurred_at) AS started_at,max(received_at) AS last_seen,max(tick) AS ticks,
        count(*) FILTER (WHERE kind='trade')::int AS fills,
        count(*) FILTER (WHERE payload->>'event_type'='strategy.target')::int AS targets,
        coalesce(sum(CASE WHEN payload->>'event_type'='execution.fill'
          AND payload->'data'->>'kind'='close'
          THEN (payload->'data'->>'net')::numeric ELSE 0 END),0)::float8 AS realized_net,
        max(CASE WHEN payload->>'event_type'='run.started'
          THEN payload->'data'->'strategy'->>'id' END) AS strategy_id,
        max(CASE WHEN payload->>'event_type'='run.started'
          THEN payload->'data'->>'mode' END) AS mode
      FROM public.survival_events
      WHERE received_at > now()-interval '24 hours'
      GROUP BY run_id
    )
    SELECT run_id::text,started_at,last_seen,ticks,fills,targets,realized_net,
      coalesce(strategy_id,'legacy') AS strategy_id,mode
    FROM recent ORDER BY last_seen DESC LIMIT 12
  `;
  const events=await sql`
    SELECT run_id::text,sequence,tick,occurred_at,payload->>'event_type' AS event_type,
      coalesce(payload->'data'->>'strategy_id',payload->'data'->'intent'->>'strategy_id',
        payload->'data'->'strategy'->>'id') AS strategy_id,
      payload->'data'->>'exposure' AS exposure,payload->'data'->>'kind' AS fill_kind,
      payload->'data'->>'side' AS side,payload->'data'->>'net' AS net
    FROM public.survival_events
    ORDER BY received_at DESC,run_id DESC,sequence DESC LIMIT 30
  `;
  return {ok:true,generated_at:new Date().toISOString(),runs,events};
}

async function insertHistory(sql,rows){
  if(!rows.length)return;
  const json=JSON.stringify(rows);
  await sql`
    INSERT INTO public.market_history(provider,product,cadence,observed_at,open,high,low,close,volume)
    SELECT x.provider,x.product,x.cadence,x.observed_at,x.open,x.high,x.low,x.close,x.volume
    FROM jsonb_to_recordset(${json}::jsonb)
      AS x(provider text,product text,cadence text,observed_at timestamptz,
        open double precision,high double precision,low double precision,
        close double precision,volume double precision)
    ON CONFLICT(provider,product,cadence,observed_at) DO UPDATE SET
      open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
      volume=excluded.volume,ingested_at=now()
  `;
}

async function refreshKrakenDaily(sql,product){
  const pair=product==="BTC-USD"?"XBTUSD":null;
  if(!pair)throw new Error("unsupported Kraken history product");
  const u=new URL("https://api.kraken.com/0/public/OHLC");
  u.searchParams.set("pair",pair);
  u.searchParams.set("interval","1440");
  const res=await fetch(u,{headers:{"accept":"application/json","user-agent":"survival-lab-history/1.0"}});
  if(!res.ok){const detail=(await res.text()).slice(0,160);throw new Error("kraken history HTTP "+res.status+" "+detail)}
  const body=await res.json();
  if(body?.error?.length)throw new Error("kraken history "+body.error.join(","));
  const key=Object.keys(body?.result||{}).find(k=>k!=="last");
  const candles=key?body.result[key]:[];
  const rows=[];
  for(const c of candles){
    if(!Array.isArray(c)||c.length<7)continue;
    const time=Number(c[0]),open=Number(c[1]),high=Number(c[2]),low=Number(c[3]),close=Number(c[4]),volume=Number(c[6]);
    if(!Number.isFinite(time)||![open,high,low,close,volume].every(Number.isFinite))continue;
    rows.push({provider:"kraken-spot",product,cadence:"1d",
      observed_at:new Date(time*1000).toISOString(),open,high,low,close,volume});
  }
  await insertHistory(sql,rows);
  return rows.length;
}

async function refreshKrakenFuturesDaily(sql,product,days){
  if(product!=="PF_XBTUSD")throw new Error("unsupported Kraken futures product");
  const from=Math.floor((Date.now()-(days+5)*86400000)/1000);
  const u=new URL("https://futures.kraken.com/api/charts/v1/trade/"+product+"/1d");
  u.searchParams.set("from",String(from));
  const res=await fetch(u,{headers:{"accept":"application/json","user-agent":"survival-lab-history/1.0"}});
  if(!res.ok){const detail=(await res.text()).slice(0,160);throw new Error("kraken futures history HTTP "+res.status+" "+detail)}
  const body=await res.json();
  const rows=[];
  for(const c of body?.candles||[]){
    const time=Number(c.time),open=Number(c.open),high=Number(c.high),low=Number(c.low),close=Number(c.close),volume=Number(c.volume);
    if(!Number.isFinite(time)||![open,high,low,close,volume].every(Number.isFinite))continue;
    rows.push({provider:"kraken-futures",product,cadence:"1d",
      observed_at:new Date(time).toISOString(),open,high,low,close,volume});
  }
  await insertHistory(sql,rows);
  return rows.length;
}

function historyProvider(product){return product==="PF_XBTUSD"?"kraken-futures":"kraken-spot"}

async function readHistory(sql,product,days){
  const provider=historyProvider(product);
  const cutoff=new Date(Date.now()-days*86400000).toISOString();
  return sql`
    SELECT provider,product,cadence,observed_at,open,high,low,close,volume
    FROM public.market_history
    WHERE provider=${provider} AND product=${product}
      AND cadence='1d' AND observed_at>=${cutoff}::timestamptz
    ORDER BY observed_at ASC
  `;
}

async function historyPayload(sql,product,days){
  const provider=historyProvider(product);
  let rows=await readHistory(sql,product,days);
  const latest=rows.length?new Date(rows[rows.length-1].observed_at).getTime():0;
  const stale=Date.now()-latest>36*3600000;
  if(rows.length<Math.max(20,days-5)||stale){
    if(product==="PF_XBTUSD")await refreshKrakenFuturesDaily(sql,product,days+5);
    else await refreshKrakenDaily(sql,product);
    rows=await readHistory(sql,product,days);
  }
  return {
    ok:true,provider,product,cadence:"1d",
    contract:{
      kind:"ohlcv",fields:["open","high","low","close","volume"],
      price_type:product==="PF_XBTUSD"?"perpetual_futures":"spot"
    },
    count:rows.length,coverage_start:rows[0]?.observed_at||null,
    coverage_end:rows[rows.length-1]?.observed_at||null,
    observations:rows
  };
}

export default {
  async fetch(request,env){
    const allowedOrigin=env.EVIDENCE_ALLOWED_ORIGIN||"*";
    const requestOrigin=request.headers.get("origin");
    const responseOrigin=allowedOrigin==="*"?"*":allowedOrigin;
    if(request.method==="OPTIONS"){
      if(!originAllowed(allowedOrigin,requestOrigin))return new Response(null,{status:403});
      return new Response(null,{status:204,headers:cors(responseOrigin)});
    }
    const url=new URL(request.url);
    if(url.pathname==="/healthz"){
      return Response.json({ok:true,store:"neon",history:"market_history"},{headers:cors(responseOrigin)});
    }
    if(!originAllowed(allowedOrigin,requestOrigin)){
      return Response.json({error:"origin denied"},{status:403,headers:cors(responseOrigin)});
    }
    if(!env.DATABASE_URL){
      return Response.json({error:"database unavailable"},{status:503,headers:cors(responseOrigin)});
    }
    const sql=neon(env.DATABASE_URL);
    if(url.pathname==="/api/ledger"&&request.method==="GET"){
      try{return Response.json(await readLedger(sql),{headers:{...cors(responseOrigin),"cache-control":"no-store"}})}
      catch{return Response.json({error:"ledger unavailable"},{status:503,headers:cors(responseOrigin)})}
    }
    if(url.pathname==="/api/history"&&request.method==="GET"){
      const product=(url.searchParams.get("product")||"BTC-USD").toUpperCase();
      const cadence=url.searchParams.get("cadence")||"1d";
      const days=Math.max(30,Math.min(730,Number(url.searchParams.get("days")||430)));
      if(!HISTORY_PRODUCTS.has(product)||cadence!=="1d"||!Number.isFinite(days)){
        return Response.json({error:"unsupported history contract"},{status:400,headers:cors(responseOrigin)});
      }
      try{
        const data=await historyPayload(sql,product,Math.floor(days));
        return Response.json(data,{headers:{...cors(responseOrigin),"cache-control":"public, max-age=300"}});
      }catch(e){
        return Response.json({error:"history unavailable",detail:String(e?.message||e)},{status:503,headers:cors(responseOrigin)});
      }
    }
    if(url.pathname!=="/api/events"||request.method!=="POST"){
      return Response.json({error:"not found"},{status:404,headers:cors(responseOrigin)});
    }
    let body;
    try{body=await request.json()}catch{
      return Response.json({error:"invalid json"},{status:400,headers:cors(responseOrigin)});
    }
    const records=Array.isArray(body.records)?body.records:[];
    if(!records.length||records.length>50){
      return Response.json({error:"records must contain 1..50 events"},{status:400,headers:cors(responseOrigin)});
    }
    for(const r of records){
      if(!r.run_id||!Number.isInteger(r.sequence)||r.sequence<0||!Number.isInteger(r.tick)||r.tick<0||
        !ALLOWED_KINDS.has(r.kind)||!r.occurred_at||!r.payload){
        return Response.json({error:"invalid evidence record"},{status:400,headers:cors(responseOrigin)});
      }
    }
    const json=JSON.stringify(records);
    await sql`
      INSERT INTO public.survival_events(run_id,sequence,tick,kind,occurred_at,payload)
      SELECT x.run_id::uuid,x.sequence,x.tick,x.kind,x.occurred_at,x.payload
      FROM jsonb_to_recordset(${json}::jsonb)
        AS x(run_id text,sequence integer,tick integer,kind text,occurred_at timestamptz,payload jsonb)
      ON CONFLICT (run_id,sequence) DO NOTHING
    `;
    return Response.json({ok:true,accepted:records.length},{headers:cors(responseOrigin)});
  }
};
