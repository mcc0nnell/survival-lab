function canonical(value){
  if(Array.isArray(value)) return "["+value.map(canonical).join(",")+"]";
  if(value&&typeof value==="object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
  return JSON.stringify(value);
}
async function sha256(text){
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
const KIND_BY_TYPE=Object.freeze({
  "run.started":"run_start",
  "run.ended":"run_end",
  "agent.consensus":"decision",
  "risk.decision":"decision",
  "execution.fill":"trade",
  "market.observation":"system",
  "feed.error":"system",
  "control":"control",
  "hold":"hold"
});
export class EvidenceLog{
  constructor({endpoint=null,maxLocal=500}={}){
    this.endpoint=endpoint;this.maxLocal=maxLocal;this.runId=crypto.randomUUID();
    this.sequence=0;this.prevHash="0".repeat(64);this.queue=[];this.remoteState=endpoint?"pending":"local";this.flushing=null;
    this.timer=setInterval(()=>this.flush().catch(()=>{}),5000);
  }
  async append(type,payload={},tick=0){
    const kind=KIND_BY_TYPE[type]||"system";
    const occurred_at=new Date().toISOString();
    const base={run_id:this.runId,sequence:++this.sequence,tick,kind,occurred_at,event_type:type,payload,prev_hash:this.prevHash};
    const hash=await sha256(canonical(base));
    const record={
      run_id:base.run_id,sequence:base.sequence,tick:base.tick,kind:base.kind,occurred_at:base.occurred_at,
      payload:{event_type:type,data:payload,evidence:{prev_hash:this.prevHash,hash}}
    };
    this.prevHash=hash;this.queue.push(record);this.persist(record);
    if(this.queue.length>=25) this.flush().catch(()=>{});
    return record;
  }
  persist(record){
    try{
      const key="survival_lab_evidence_v3";
      const arr=JSON.parse(localStorage.getItem(key)||"[]");arr.push(record);
      if(arr.length>this.maxLocal) arr.splice(0,arr.length-this.maxLocal);
      localStorage.setItem(key,JSON.stringify(arr));
    }catch{}
  }
  async flush({keepalive=false,force=false}={}){
    if(!this.endpoint||!this.queue.length)return false;
    if(this.flushing&&!force)return this.flushing;
    const batch=this.queue.slice(0,50);
    const sent=new Set(batch.map(r=>r.run_id+":"+r.sequence));
    const request=(async()=>{
      try{
        const r=await fetch(this.endpoint,{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({records:batch}),keepalive});
        if(!r.ok)throw new Error("evidence HTTP "+r.status);
        this.queue=this.queue.filter(r=>!sent.has(r.run_id+":"+r.sequence));
        this.remoteState="synced";return true;
      }catch(e){this.remoteState="offline";throw e;}
    })();
    if(!force){
      this.flushing=request;
      try{return await request}finally{if(this.flushing===request)this.flushing=null}
    }
    return request;
  }
  async verify(records){
    let prev="0".repeat(64);
    for(const rec of records){
      const ev=rec?.payload?.evidence;
      if(!ev||ev.prev_hash!==prev) return false;
      const base={run_id:rec.run_id,sequence:rec.sequence,tick:rec.tick,kind:rec.kind,occurred_at:rec.occurred_at,
        event_type:rec.payload.event_type,payload:rec.payload.data,prev_hash:ev.prev_hash};
      if(await sha256(canonical(base))!==ev.hash) return false;
      prev=ev.hash;
    }
    return true;
  }
  close(){clearInterval(this.timer);this.flush({keepalive:true,force:true}).catch(()=>{});}
}
