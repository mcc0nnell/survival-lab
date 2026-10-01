import { neon } from "@neondatabase/serverless";

const ALLOWED_KINDS=new Set(["run_start","run_end","decision","trade","hold","control","system"]);
const cors=origin=>({
  "content-type":"application/json",
  "access-control-allow-origin":origin||"*",
  "access-control-allow-methods":"POST,OPTIONS",
  "access-control-allow-headers":"content-type"
});

export default {
  async fetch(request,env){
    const allowedOrigin=env.EVIDENCE_ALLOWED_ORIGIN||"*";
    const requestOrigin=request.headers.get("origin");
    const responseOrigin=allowedOrigin==="*"?"*":allowedOrigin;
    if(request.method==="OPTIONS"){
      if(allowedOrigin!=="*"&&requestOrigin&&requestOrigin!==allowedOrigin) return new Response(null,{status:403});
      return new Response(null,{status:204,headers:cors(responseOrigin)});
    }
    const url=new URL(request.url);
    if(url.pathname==="/healthz"){
      return Response.json({ok:true,store:"neon"},{headers:cors(responseOrigin)});
    }
    if(url.pathname!=="/api/events"||request.method!=="POST"){
      return Response.json({error:"not found"},{status:404,headers:cors(responseOrigin)});
    }
    if(allowedOrigin!=="*"&&requestOrigin&&requestOrigin!==allowedOrigin){
      return Response.json({error:"origin denied"},{status:403,headers:cors(responseOrigin)});
    }
    if(!env.DATABASE_URL){
      return Response.json({error:"database unavailable"},{status:503,headers:cors(responseOrigin)});
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
    const sql=neon(env.DATABASE_URL);
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
