import { neon } from "@neondatabase/serverless";

const ALLOWED_KINDS=new Set(["run_start","run_end","decision","trade","hold","control","system"]);
const cors=origin=>({
  "content-type":"application/json",
  "access-control-allow-origin":origin||"*",
  "access-control-allow-methods":"GET,POST,OPTIONS",
  "access-control-allow-headers":"content-type"
});

function originAllowed(allowedOrigin,requestOrigin){
  return allowedOrigin==="*"||!requestOrigin||requestOrigin===allowedOrigin;
}

async function readLedger(sql){
  const runs=await sql`
    WITH recent AS (
      SELECT run_id,
        min(occurred_at) AS started_at,
        max(received_at) AS last_seen,
        max(tick) AS ticks,
        count(*) FILTER (WHERE kind='trade')::int AS fills,
        count(*) FILTER (WHERE payload->>'event_type'='strategy.target')::int AS targets,
        coalesce(sum(
          CASE WHEN payload->>'event_type'='execution.fill'
            AND payload->'data'->>'kind'='close'
          THEN (payload->'data'->>'net')::numeric ELSE 0 END
        ),0)::float8 AS realized_net,
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
      coalesce(
        payload->'data'->>'strategy_id',
        payload->'data'->'intent'->>'strategy_id',
        payload->'data'->'strategy'->>'id'
      ) AS strategy_id,
      payload->'data'->>'exposure' AS exposure,
      payload->'data'->>'kind' AS fill_kind,
      payload->'data'->>'side' AS side,
      payload->'data'->>'net' AS net
    FROM public.survival_events
    ORDER BY received_at DESC,run_id DESC,sequence DESC LIMIT 30
  `;
  return {ok:true,generated_at:new Date().toISOString(),runs,events};
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
      return Response.json({ok:true,store:"neon"},{headers:cors(responseOrigin)});
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
      catch(e){return Response.json({error:"ledger unavailable"},{status:503,headers:cors(responseOrigin)})}
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
