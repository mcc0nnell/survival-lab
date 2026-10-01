import { neon } from "@neondatabase/serverless";

const cors=origin=>({
  "content-type":"application/json",
  "access-control-allow-origin":origin||"*",
  "access-control-allow-methods":"POST,OPTIONS",
  "access-control-allow-headers":"content-type"
});

export default {
  async fetch(request,env){
    const origin=env.EVIDENCE_ALLOWED_ORIGIN||"*";
    if(request.method==="OPTIONS"){
      return new Response(null,{status:204,headers:cors(origin)});
    }
    const url=new URL(request.url);
    if(url.pathname==="/healthz"){
      return Response.json({ok:true,store:"neon"},{headers:cors(origin)});
    }
    if(url.pathname!=="/api/events"||request.method!=="POST"){
      return Response.json({error:"not found"},{status:404,headers:cors(origin)});
    }
    if(!env.DATABASE_URL){
      return Response.json({error:"database unavailable"},{status:503,headers:cors(origin)});
    }
    let body;
    try{ body=await request.json(); }
    catch{
      return Response.json({error:"invalid json"},{status:400,headers:cors(origin)});
    }
    const records=Array.isArray(body.records)?body.records:[];
    if(!records.length||records.length>50){
      return Response.json({error:"records must contain 1..50 events"},{status:400,headers:cors(origin)});
    }
    for(const r of records){
      if(!r.run_id||!Number.isInteger(r.seq)||!r.type||!r.hash||!r.prev_hash){
        return Response.json({error:"invalid evidence record"},{status:400,headers:cors(origin)});
      }
    }
    const sql=neon(env.DATABASE_URL);
    const json=JSON.stringify(records);
    await sql`
      INSERT INTO survival_events(run_id,seq,ts,event_type,payload,prev_hash,event_hash)
      SELECT x.run_id::uuid,x.seq,x.ts,x.type,x.payload,x.prev_hash,x.hash
      FROM jsonb_to_recordset(${json}::jsonb)
        AS x(run_id text,seq bigint,ts timestamptz,type text,payload jsonb,prev_hash text,hash text)
      ON CONFLICT (run_id,seq) DO NOTHING
    `;
    return Response.json(
      {ok:true,accepted:records.length},
      {headers:cors(origin)}
    );
  }
};
