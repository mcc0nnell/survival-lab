function canonical(value){
  if(Array.isArray(value)) return "["+value.map(canonical).join(",")+"]";
  if(value&&typeof value==="object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
  return JSON.stringify(value);
}
async function sha256(text){
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

export class EvidenceLog{
  constructor({endpoint=null,maxLocal=500}={}){
    this.endpoint=endpoint;this.maxLocal=maxLocal;this.runId=crypto.randomUUID();
    this.seq=0;this.prevHash="0".repeat(64);this.queue=[];this.remoteState=endpoint?"pending":"local";
    this.timer=setInterval(()=>this.flush().catch(()=>{}),5000);
  }
  async append(type,payload={}){
    const body={run_id:this.runId,seq:++this.seq,ts:new Date().toISOString(),type,payload,prev_hash:this.prevHash};
    const hash=await sha256(canonical(body));
    const record={...body,hash};this.prevHash=hash;this.queue.push(record);this.persist(record);
    if(this.queue.length>=25) this.flush().catch(()=>{});
    return record;
  }
  persist(record){
    try{
      const key="survival_lab_evidence_v2";
      const arr=JSON.parse(localStorage.getItem(key)||"[]");arr.push(record);
      if(arr.length>this.maxLocal) arr.splice(0,arr.length-this.maxLocal);
      localStorage.setItem(key,JSON.stringify(arr));
    }catch{}
  }
  async flush(){
    if(!this.endpoint||!this.queue.length) return false;
    const batch=this.queue.slice(0,50);
    try{
      const r=await fetch(this.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({records:batch})});
      if(!r.ok) throw new Error("evidence HTTP "+r.status);
      this.queue.splice(0,batch.length);this.remoteState="synced";return true;
    }catch(e){this.remoteState="offline";throw e;}
  }
  async verify(records){
    let prev="0".repeat(64);
    for(const rec of records){
      if(rec.prev_hash!==prev) return false;
      const {hash,...body}=rec;
      if(await sha256(canonical(body))!==hash) return false;
      prev=hash;
    }
    return true;
  }
  close(){clearInterval(this.timer);}
}
