import { neon } from "@neondatabase/serverless";

const HISTORY_PRODUCTS=new Set(["BTC-USD","PF_XBTUSD"]);
const SESSION_KEY="paper-session";
const LEDGER_CACHE_KEY="ledger-cache";
const SESSION_MS=15*60*1000;
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

async function readSession(env){
  if(!env.SURVIVAL_CONTROL)return null;
  const raw=await env.SURVIVAL_CONTROL.get(SESSION_KEY);
  if(!raw)return null;
  try{return JSON.parse(raw)}catch{return null}
}
async function controlToken(env){
  if(!env.DATABASE_URL)return "";
  const data=new TextEncoder().encode("survival-lab-control-v1:"+env.DATABASE_URL);
  const digest=await crypto.subtle.digest("SHA-256",data);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
function sessionView(session){
  const now=Date.now(),until=Number(session?.run_until||0);
  return {
    active:until>now,
    started_at:session?.started_at||null,
    run_until:until?new Date(until).toISOString():null,
    seconds_remaining:until>now?Math.ceil((until-now)/1000):0,
    duration_minutes:15
  };
}
async function cacheLedger(env,sql){
  if(!env.SURVIVAL_CONTROL)return null;
  const data=await readLedger(sql);
  await env.SURVIVAL_CONTROL.put(LEDGER_CACHE_KEY,JSON.stringify(data),{expirationTtl:86400});
  return data;
}
async function runTraderTick(env,scheduledAt){
  const session=await readSession(env);
  const view=sessionView(session);
  if(!view.active)return {ok:true,skipped:"idle",session:view};
  if(!env.TRADER_FUNCTION_URL||!env.DATABASE_URL){
    return {ok:false,error:"trader control unavailable",session:view};
  }
  const invocationId="cf-"+new Date(scheduledAt).toISOString();
  const res=await fetch(env.TRADER_FUNCTION_URL,{
    method:"POST",
    headers:{"content-type":"application/json","authorization":"Bearer "+await controlToken(env)},
    body:JSON.stringify({data:{scheduled_at:new Date(scheduledAt).toISOString(),invocation_id:invocationId}})
  });
  let result;
  try{result=await res.json()}catch{result={error:"invalid trader response"}}
  if(env.DATABASE_URL&&env.SURVIVAL_CONTROL){
    try{await cacheLedger(env,neon(env.DATABASE_URL))}catch{}
  }
  await env.SURVIVAL_CONTROL.put("last-tick",JSON.stringify({
    at:new Date().toISOString(),status:res.status,result
  }),{expirationTtl:86400});
  return {ok:res.ok,status:res.status,result,session:view};
}

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
  const runnerStates=await sql`
    SELECT run_id::text,occurred_at,
      (payload->'data'->'state'->>'tick')::int AS tick,
      (payload->'data'->>'samples')::int AS samples,
      payload->'data'->>'scheduled_at' AS scheduled_at,
      payload->'data'->'state'->'account' AS account
    FROM public.survival_events
    WHERE payload->>'event_type'='runner.state'
      AND payload->'data'->>'runner'='neon-scheduled'
    ORDER BY occurred_at DESC,received_at DESC LIMIT 1
  `;
  return {ok:true,generated_at:new Date().toISOString(),runs,events,runner_state:runnerStates[0]||null};
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
  async fetch(request,env,ctx){
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

    if(url.pathname==="/api/control/status"&&request.method==="GET"){
      const session=sessionView(await readSession(env));
      let last_tick=null;
      if(env.SURVIVAL_CONTROL){
        try{last_tick=JSON.parse(await env.SURVIVAL_CONTROL.get("last-tick")||"null")}catch{}
      }
      return Response.json({ok:true,...session,last_tick},{headers:{...cors(responseOrigin),"cache-control":"no-store"}});
    }
    if(url.pathname==="/api/control/start"&&request.method==="POST"){
      if(!requestOrigin||requestOrigin!==allowedOrigin)return Response.json({error:"origin denied"},{status:403,headers:cors(responseOrigin)});
      if(!env.SURVIVAL_CONTROL)return Response.json({error:"control unavailable"},{status:503,headers:cors(responseOrigin)});
      const now=Date.now();
      const session={started_at:new Date(now).toISOString(),run_until:now+SESSION_MS};
      await env.SURVIVAL_CONTROL.put(SESSION_KEY,JSON.stringify(session),{expirationTtl:30*60});
      ctx.waitUntil(runTraderTick(env,now));
      return Response.json({ok:true,...sessionView(session)},{headers:cors(responseOrigin)});
    }
    if(url.pathname==="/api/control/stop"&&request.method==="POST"){
      if(!requestOrigin||requestOrigin!==allowedOrigin)return Response.json({error:"origin denied"},{status:403,headers:cors(responseOrigin)});
      if(env.SURVIVAL_CONTROL)await env.SURVIVAL_CONTROL.delete(SESSION_KEY);
      return Response.json({ok:true,...sessionView(null)},{headers:cors(responseOrigin)});
    }
    if(!originAllowed(allowedOrigin,requestOrigin)){
      return Response.json({error:"origin denied"},{status:403,headers:cors(responseOrigin)});
    }
    if(url.pathname==="/api/ledger"&&request.method==="GET"&&env.SURVIVAL_CONTROL){
      try{
        const cached=await env.SURVIVAL_CONTROL.get(LEDGER_CACHE_KEY,"json");
        if(cached)return Response.json(cached,{headers:{...cors(responseOrigin),"cache-control":"no-store","x-survival-cache":"kv"}});
      }catch{}
    }
    if(!env.DATABASE_URL){
      return Response.json({error:"database unavailable"},{status:503,headers:cors(responseOrigin)});
    }
    const sql=neon(env.DATABASE_URL);
    if(url.pathname==="/api/ledger"&&request.method==="GET"){
      try{
        const data=await cacheLedger(env,sql);
        return Response.json(data||await readLedger(sql),{headers:{...cors(responseOrigin),"cache-control":"no-store","x-survival-cache":"neon"}});
      }catch{return Response.json({error:"ledger unavailable"},{status:503,headers:cors(responseOrigin)})}
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
    if(url.pathname==="/api/events"&&request.method==="POST"){
      return Response.json({error:"browser event ingestion disabled"},{status:410,headers:cors(responseOrigin)});
    }
    return Response.json({error:"not found"},{status:404,headers:cors(responseOrigin)});
  },
  async scheduled(event,env,ctx){
    ctx.waitUntil(runTraderTick(env,event.scheduledTime));
  }
};
