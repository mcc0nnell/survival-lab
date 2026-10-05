import {DEFAULT_CONFIG,AGENTS,createAccount,markAccount,riskDecision,openPaper,closePaper,evaluateExit,enforceKillSwitch} from "./core.js";
import {createStrategy,STRATEGY_REGISTRY} from "./strategies.js";
import {HistoryPlane,compatibility,bootstrapStrategy} from "./history.js";
import {runHistoricalTournament,runDonchianForwardShadow,DONCHIAN_SHADOW_START} from "./backtest.js";
import {CoinbaseFeed,SyntheticFeed} from "./feed.js";
import {EvidenceLog} from "./evidence.js";
import {buildReplayModel,replaySnapshot} from "./replay.js";

const el=id=>document.getElementById(id);
const feedMode=new URLSearchParams(location.search).get("feed")==="synthetic"?"synthetic":"live";
const evidenceEndpoint=document.querySelector('meta[name="survival-evidence-endpoint"]')?.content||null;
const executionMode=document.querySelector('meta[name="survival-execution-mode"]')?.content||"browser";
const autonomous=executionMode==="neon"&&feedMode==="live";
const ledgerEndpoint=evidenceEndpoint?.replace(/\/api\/events$/, "/api/ledger")||null;
const controlBase=evidenceEndpoint?.replace(/\/api\/events$/, "/api/control")||null;
const historyEndpoint=evidenceEndpoint?.replace(/\/api\/events$/, "/api/history")||null;
const historyPlane=new HistoryPlane({endpoint:historyEndpoint});
const STRATEGY_MS=1000, SYNTHETIC_MS=900, VISUAL_SAMPLE_MS=80, DEPTH_RENDER_MS=100, REPLAY_DURATION_MS=30000, REPLAY_WINDOW=70;
const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
let feed,log,state,strategy,strategyTimer,syntheticTimer,ledgerTimer,controlPollTimer,controlClockTimer,rafId,started,speed=1,nextStrategyAt=0,historyDataset=null,futuresDataset=null,tournamentData=null,shadowData=null,sessionUntil=0,replayModel=null,replayIndex=0,replayPlaying=false,replayStartAt=0,replayStartIndex=0,replaySelectedId="donchian-45-10";
const strategyPreviews=new Map();

function newState(){
  return {
    tick:0,account:createAccount(),history:[],equities:Array(70).fill(DEFAULT_CONFIG.initialEquity),
    visualHistory:[],events:[],signals:[],quote:null,targetPrice:null,displayPrice:null,
    paused:false,feedErrors:0,feedState:"CONNECTING",lastStrategySequence:null,
    lastVisualSampleAt:0,lastDepthRenderAt:0,lastFrameAt:0,depthDirty:false,slowDirty:true,
    lastStatus:null,staleLogged:false
  };
}
function makeFeed(){return feedMode==="synthetic"?new SyntheticFeed():new CoinbaseFeed("BTC-USD")}
function shortRun(id){return id?String(id).slice(0,8):"—"}
function fmtNet(v){const n=Number(v);return Number.isFinite(n)?(n>=0?"+":"")+"$"+n.toFixed(4):"—"}

function renderSessionControl(){
  if(!autonomous)return;
  const remaining=Math.max(0,sessionUntil-Date.now());
  const active=remaining>0;
  const mins=Math.floor(remaining/60000),secs=Math.floor((remaining%60000)/1000);
  el("run20").hidden=active;
  el("stopRun").hidden=!active;
  if(active){
    el("stopRun").textContent="STOP · "+String(mins).padStart(2,"0")+":"+String(secs).padStart(2,"0");
    document.querySelector(".mode").textContent="NEON PAPER · RUNNING";
  }else{
    el("run20").textContent="RUN 15 MIN";
    document.querySelector(".mode").textContent="NEON PAPER · IDLE";
  }
}
async function refreshControlStatus(){
  if(!autonomous||!controlBase)return;
  try{
    const res=await fetch(controlBase+"/status",{cache:"no-store"});
    if(res.ok){
      const data=await res.json();
      sessionUntil=data.active&&data.run_until?Date.parse(data.run_until):0;
      renderSessionControl();
    }
  }catch{}
  clearTimeout(controlPollTimer);
  controlPollTimer=setTimeout(refreshControlStatus,5000);
}
async function setSession(action){
  if(!autonomous||!controlBase)return;
  const button=action==="start"?el("run20"):el("stopRun");
  button.disabled=true;
  try{
    const res=await fetch(controlBase+"/"+action,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    if(!res.ok)throw new Error("HTTP "+res.status);
    const data=await res.json();
    sessionUntil=data.active&&data.run_until?Date.parse(data.run_until):0;
    renderSessionControl();
    addEvent("sys","SYSTEM",action==="start"?"15-minute Neon session armed":"Neon session stopped");
  }catch(e){
    addEvent("sell","CONTROL","Timer control failed · "+e.message);
  }finally{
    button.disabled=false;
  }
}
async function refreshLedger(){
  if(!ledgerEndpoint)return;
  try{
    const res=await fetch(ledgerEndpoint,{cache:"no-store"});
    if(!res.ok)throw new Error("HTTP "+res.status);
    const data=await res.json();
    if(autonomous&&data.runner_state?.account){
      state.account={...createAccount(),...data.runner_state.account};
      const remoteTick=Number(data.runner_state.tick);
      if(Number.isInteger(remoteTick)&&remoteTick>=0)state.tick=remoteTick;
      state.slowDirty=true;
    }
    const runs=(data.runs||[]).slice(0,8);
    const events=(data.events||[]).slice(0,12);
    el("neonRuns").innerHTML='<div class="neonRow"><b>RUN</b><b>STRATEGY</b><b>TICKS</b><b>FILLS</b><b>NET</b></div>'+
      runs.map(r=>'<div class="neonRow"><b title="'+r.run_id+'">'+shortRun(r.run_id)+'</b><span>'+String(r.strategy_id||"legacy")+'</span><span>'+r.ticks+'</span><span>'+r.fills+'</span><span>'+fmtNet(r.realized_net)+'</span></div>').join("");
    el("neonEvents").innerHTML='<div class="neonRow"><b>TICK</b><b>EVENT</b><b>STRATEGY</b><b>VALUE</b></div>'+
      events.map(e=>{const value=e.event_type==="strategy.target"&&e.exposure!=null?Number(e.exposure).toFixed(3):e.event_type==="execution.fill"?(e.fill_kind||"fill")+" "+(e.side||"")+" "+fmtNet(e.net):"";
        return '<div class="neonRow"><b>#'+String(e.tick).padStart(3,"0")+'</b><span>'+String(e.event_type||"")+'</span><span>'+String(e.strategy_id||"—")+'</span><span>'+value+'</span></div>'}).join("");
    el("neonState").textContent="NEON · "+runs.length+" RUNS · "+new Date(data.generated_at).toLocaleTimeString();
  }catch(e){
    el("neonState").textContent="NEON UNAVAILABLE";
  }finally{
    ledgerTimer=setTimeout(refreshLedger,5000);
  }
}

function renderStrategyCatalog(){
  const cards=Object.values(STRATEGY_REGISTRY).map(entry=>{
    const m=entry.manifest;
    let stateLabel=m.status==="research"?"RESEARCH":m.status==="replay"?"REPLAY":m.status==="active"?"ACTIVE":"READY";
    let reason=m.note||"";
    if(m.history_contract){
      const c=compatibility(m,historyPlane);
      if(c.state==="BLOCKED"){stateLabel="BLOCKED";reason=c.reason}
      else if(m.status!=="replay"){stateLabel=c.state;reason=c.reason}
    }
    const preview=strategyPreviews.get(m.id);
    if(preview){
      const sign=preview.exposure>=0?"+":"";
      reason="TARGET "+sign+preview.exposure.toFixed(3)+" · "+preview.rationale;
    }
    const cadence=m.sampling||"—",lookback=m.lookback||"—";
    const cls=stateLabel.toLowerCase();
    return '<article class="cartridge"><div class="cartridgeTop"><div class="cartridgeName">'+m.name+
      '</div><div class="cartridgeState '+cls+'">'+stateLabel+'</div></div>'+
      '<div class="cartridgeMeta">'+m.id+' · '+cadence+'<br>'+lookback+
      (reason?'<br>'+reason:'')+'</div></article>';
  });
  el("strategyCatalog").innerHTML=cards.join("");
}
function fmtPct(v){
  const n=Number(v);return Number.isFinite(n)?(n>=0?"+":"")+(n*100).toFixed(2)+"%":"—";
}
function fmtSharpe(v){
  const n=Number(v);return Number.isFinite(n)?n.toFixed(2):"—";
}
function drawTournamentChart(){
  const c=el("tournamentChart");if(!c||!tournamentData?.results?.length)return;
  const dpr=Math.min(devicePixelRatio||1,2),w=c.clientWidth,h=c.clientHeight;
  const pw=Math.max(1,Math.round(w*dpr)),ph=Math.max(1,Math.round(h*dpr));
  if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph}
  const x=c.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
  x.strokeStyle="#172026";x.lineWidth=1;
  for(let i=0;i<5;i++){const y=16+i*(h-34)/4;x.beginPath();x.moveTo(10,y);x.lineTo(w-10,y);x.stroke()}
  const curves=tournamentData.results.map(r=>r.curve).filter(a=>a?.length);
  const all=curves.flat(),times=all.map(p=>new Date(p.at).getTime()).filter(Number.isFinite),values=all.map(p=>p.equity).filter(Number.isFinite);
  if(!times.length||!values.length)return;
  const minT=Math.min(...times),maxT=Math.max(...times),minV=Math.min(...values),maxV=Math.max(...values),spanT=maxT-minT||1,spanV=maxV-minV||1;
  const colors=["#70ff9f","#67d9ff","#ffbf69","#ff7096","#b38cff","#8fe0c0"];
  tournamentData.results.forEach((r,i)=>{
    if(!r.curve?.length)return;
    x.strokeStyle=colors[i%colors.length];x.lineWidth=1.6;x.beginPath();
    r.curve.forEach((p,j)=>{
      const t=new Date(p.at).getTime(),px=10+(t-minT)/spanT*(w-20),py=16+(maxV-p.equity)/spanV*(h-34);
      j?x.lineTo(px,py):x.moveTo(px,py);
    });
    x.stroke();
  });
}
function renderTournament(){
  if(!el("tournamentRows"))return;
  if(!tournamentData?.results?.length){
    el("tournamentRows").innerHTML='<div class="tournamentEmpty">Waiting for history.</div>';
    el("tournamentLegend").innerHTML="";
    return;
  }
  const colors=["#70ff9f","#67d9ff","#ffbf69","#ff7096","#b38cff","#8fe0c0"];
  const ranked=[...tournamentData.results].sort((a,b)=>b.total_return-a.total_return);
  el("tournamentRows").innerHTML='<div class="tournamentRow tournamentHeader"><b>STRATEGY</b><span>RETURN</span><span>MAX DD</span><span>SHARPE</span><span>TURNOVER</span><span>VS BENCH</span></div>'+
    ranked.map((r,i)=>'<div class="tournamentRow"><b>#'+(i+1)+' '+r.name+'</b>'+
      '<span class="'+(r.total_return>=0?"pos":"neg")+'">'+fmtPct(r.total_return)+'</span>'+
      '<span>'+fmtPct(-r.max_drawdown).replace("-","")+'</span>'+
      '<span>'+fmtSharpe(r.sharpe)+'</span><span>'+r.turnover.toFixed(1)+'×</span>'+
      '<span class="'+(r.relative_return>=0?"pos":"neg")+'">'+fmtPct(r.relative_return)+'</span></div>').join("");
  el("tournamentLegend").innerHTML=tournamentData.results.map((r,i)=>'<span><i style="background:'+colors[i%colors.length]+'"></i>'+r.name+'</span>').join("");
  el("tournamentState").textContent=tournamentData.evaluation_days+"D · "+tournamentData.cost_bps.toFixed(1)+" BPS / TURNOVER · PRIOR HISTORY WARMUP";
  requestAnimationFrame(drawTournamentChart);
}

function renderShadow(){
  if(!el("shadowRows"))return;
  if(!shadowData?.results?.length){
    el("shadowRows").innerHTML='<div class="tournamentEmpty">Waiting for history.</div>';
    el("shadowState").textContent="FROZEN AFTER 2026-10-02";
    return;
  }
  const observations=Math.max(...shadowData.results.map(r=>r.observations||0));
  el("shadowState").textContent=observations
    ?"OUT-OF-SAMPLE · "+observations+" DAILY BARS · START "+DONCHIAN_SHADOW_START.slice(0,10)
    :"FROZEN AFTER 2026-10-02 · WAITING FOR FIRST NEW DAILY BAR";
  el("shadowRows").innerHTML='<div class="shadowRow shadowHeader"><b>STRATEGY</b><span>RETURN</span><span>MAX DD</span><span>SHARPE</span><span>TURNOVER</span><span>BARS</span></div>'+
    shadowData.results.map(r=>'<div class="shadowRow"><b>'+r.name+'</b>'+
      '<span class="'+(r.total_return>=0?"pos":"neg")+'">'+fmtPct(r.total_return)+'</span>'+
      '<span>'+fmtPct(-r.max_drawdown).replace("-","")+'</span>'+
      '<span>'+fmtSharpe(r.sharpe)+'</span><span>'+r.turnover.toFixed(1)+'×</span><span>'+r.observations+'</span></div>').join("");
}


const REPLAY_COLORS=["#70ff9f","#67d9ff","#ffbf69","#ff7096","#b38cff","#8fe0c0"];

function clearReplay(message="Waiting for history."){
  replayModel=null;replayIndex=0;replayPlaying=false;
  const select=el("replayStrategy"),play=el("replayPlay"),pause=el("replayPause"),scrub=el("replayScrub");
  if(select){select.disabled=true;select.innerHTML="<option>WAITING FOR HISTORY</option>"}
  if(play)play.disabled=true;
  if(pause){pause.disabled=true;pause.textContent="PAUSE"}
  if(scrub){scrub.max="0";scrub.value="0"}
  if(el("replayRace"))el("replayRace").innerHTML='<div class="tournamentEmpty">'+message+'</div>';
  if(el("replayDate"))el("replayDate").textContent="DATE —";
  if(el("replayEquity"))el("replayEquity").textContent="EQUITY —";
  if(el("replayReturn"))el("replayReturn").textContent="RETURN —";
  if(el("replayDd"))el("replayDd").textContent="DRAWDOWN —";
  if(el("replayFrame"))el("replayFrame").textContent="0 / 0";
}

function setupReplay(){
  replayModel=buildReplayModel({spotDataset:historyDataset,tournamentData});
  if(!replayModel.frames.length||!replayModel.results.length){clearReplay("No aligned replay window.");return}
  const select=el("replayStrategy");
  select.innerHTML=replayModel.results.map(r=>'<option value="'+r.id+'">'+r.name+'</option>').join("");
  if(!replayModel.results.some(r=>r.id===replaySelectedId))replaySelectedId=replayModel.results[0].id;
  select.value=replaySelectedId;select.disabled=false;
  el("replayPlay").disabled=false;el("replayPause").disabled=false;
  const scrub=el("replayScrub");scrub.max=String(replayModel.frames.length-1);scrub.value="0";
  el("replayFrom").textContent=replayModel.start_at?.slice(0,10)||"—";
  el("replayTo").textContent=replayModel.end_at?.slice(0,10)||"—";
  replayIndex=0;replayPlaying=false;el("replayPause").textContent="PAUSE";
  renderReplay();
}

function replayEquityAt(id,index=replayIndex){
  return Number(replayModel?.frames?.[index]?.equities?.[id]);
}
function replayDrawdownAt(id,index=replayIndex){
  if(!replayModel?.frames?.length)return 0;
  let peak=1,current=1,maxdd=0;
  for(let i=0;i<=Math.min(index,replayModel.frames.length-1);i++){
    const eq=replayEquityAt(id,i);
    if(!Number.isFinite(eq))continue;
    current=eq;peak=Math.max(peak,eq);if(peak>0)maxdd=Math.max(maxdd,(peak-eq)/peak);
  }
  return {current,drawdown:peak>0?(peak-current)/peak:0,maxdd};
}
function renderReplay(){
  const snap=replaySnapshot(replayModel,replayIndex);if(!snap)return;
  replayIndex=snap.index;
  const eq=Number(snap.frame.equities?.[replaySelectedId]);
  const dd=replayDrawdownAt(replaySelectedId,replayIndex);
  el("replayDate").textContent="DATE "+String(snap.frame.at).slice(0,10);
  el("replayEquity").textContent="EQUITY $"+(DEFAULT_CONFIG.initialEquity*(Number.isFinite(eq)?eq:1)).toFixed(2);
  el("replayReturn").textContent="RETURN "+fmtPct((Number.isFinite(eq)?eq:1)-1);
  el("replayDd").textContent="DRAWDOWN "+fmtPct(-dd.drawdown).replace("-","");
  el("replayFrame").textContent=(replayIndex+1)+" / "+snap.total;
  el("replayScrub").value=String(replayIndex);

  const entries=replayModel.results.map((r,i)=>({r,i,eq:Number(snap.frame.equities?.[r.id])||1}))
    .sort((a,b)=>b.eq-a.eq);
  const maxAbs=Math.max(.0001,...entries.map(x=>Math.abs(x.eq-1)));
  el("replayRace").innerHTML=entries.map(({r,i,eq})=>{
    const ret=eq-1,width=8+92*Math.min(1,Math.abs(ret)/maxAbs);
    return '<div class="raceRow"><span class="raceName">'+r.name+'</span><span class="raceTrack"><i style="--race-color:'+REPLAY_COLORS[i%REPLAY_COLORS.length]+';width:'+width.toFixed(1)+'%"></i></span><span class="raceValue '+(ret>=0?"pos":"neg")+'">'+fmtPct(ret)+'</span></div>';
  }).join("");
  requestAnimationFrame(drawReplayChart);
}
function drawReplayChart(){
  const c=el("replayChart");if(!c||!replayModel?.frames?.length)return;
  const dpr=Math.min(devicePixelRatio||1,2),w=c.clientWidth,h=c.clientHeight;
  const pw=Math.max(1,Math.round(w*dpr)),ph=Math.max(1,Math.round(h*dpr));
  if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph}
  const x=c.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
  const start=Math.max(0,replayIndex-REPLAY_WINDOW+1),frames=replayModel.frames.slice(start,replayIndex+1);
  if(!frames.length)return;
  const left=12,right=w-10,top=12,priceBottom=Math.max(90,h*.67),equityTop=priceBottom+20,equityBottom=h-14;
  x.strokeStyle="#172026";x.lineWidth=1;
  for(let i=0;i<4;i++){const y=top+i*(priceBottom-top)/3;x.beginPath();x.moveTo(left,y);x.lineTo(right,y);x.stroke()}
  x.beginPath();x.moveTo(left,equityTop-9);x.lineTo(right,equityTop-9);x.stroke();
  const lows=frames.map(f=>f.low),highs=frames.map(f=>f.high),minP=Math.min(...lows),maxP=Math.max(...highs),spanP=maxP-minP||1;
  const slot=(right-left)/Math.max(1,frames.length),body=Math.max(1,Math.min(7,slot*.62));
  frames.forEach((f,i)=>{
    const px=left+(i+.5)*slot,y=v=>top+(maxP-v)/spanP*(priceBottom-top);
    const up=f.close>=f.open;x.strokeStyle=up?"#70ff9f":"#ff5b68";x.fillStyle=x.strokeStyle;x.lineWidth=1;
    x.beginPath();x.moveTo(px,y(f.high));x.lineTo(px,y(f.low));x.stroke();
    const y1=y(f.open),y2=y(f.close),bh=Math.max(1,Math.abs(y2-y1));
    x.fillRect(px-body/2,Math.min(y1,y2),body,bh);
  });
  const equities=frames.map(f=>Number(f.equities?.[replaySelectedId])||1),minE=Math.min(...equities),maxE=Math.max(...equities),spanE=maxE-minE||1;
  x.strokeStyle="#67d9ff";x.lineWidth=2;x.beginPath();
  equities.forEach((v,i)=>{
    const px=left+(i+.5)*slot,py=equityTop+(maxE-v)/spanE*(equityBottom-equityTop);
    i?x.lineTo(px,py):x.moveTo(px,py);
  });
  x.stroke();
  x.fillStyle="#657177";x.font="8px ui-monospace, SFMono-Regular, Menlo, monospace";
  x.fillText("BTC-USD DAILY",left,top+8);x.fillText("SELECTED EQUITY",left,equityTop+8);
}
function startReplay(reset=true){
  if(!replayModel?.frames?.length)return;
  if(reset||replayIndex>=replayModel.frames.length-1)replayIndex=0;
  replayStartIndex=replayIndex;replayStartAt=performance.now();replayPlaying=true;
  el("replayPause").textContent="PAUSE";renderReplay();
}
function toggleReplayPause(){
  if(!replayModel?.frames?.length)return;
  if(replayPlaying){replayPlaying=false;el("replayPause").textContent="RESUME";return}
  replayStartIndex=replayIndex;replayStartAt=performance.now();replayPlaying=true;el("replayPause").textContent="PAUSE";
}
function updateReplayPlayback(ts){
  if(!replayPlaying||!replayModel?.frames?.length)return;
  const last=replayModel.frames.length-1,remaining=Math.max(1,last-replayStartIndex);
  const duration=Math.max(250,REPLAY_DURATION_MS*(remaining/Math.max(1,last)));
  const progress=Math.min(1,(ts-replayStartAt)/duration);
  const next=Math.min(last,replayStartIndex+Math.floor(progress*remaining));
  if(next!==replayIndex){replayIndex=next;renderReplay()}
  if(progress>=1){replayIndex=last;replayPlaying=false;el("replayPause").textContent="RESUME";renderReplay()}
}

async function recordHistorySnapshot(dataset){
  await log?.append("history.snapshot",{
    dataset_id:dataset.id,provider:dataset.provider,product:dataset.product,
    cadence:dataset.cadence,count:dataset.count,
    coverage_start:dataset.coverage_start,coverage_end:dataset.coverage_end
  },state?.tick||0).catch(()=>{});
}
async function loadHistoryPlane(){
  renderStrategyCatalog();
  if(!historyEndpoint){el("historyState").textContent="HISTORY · UNAVAILABLE";return}
  try{
    [historyDataset,futuresDataset]=await Promise.all([
      historyPlane.load("btc-usd-spot-1d",{days:720}),
      historyPlane.load("kraken-pf-xbtusd-1d",{days:720})
    ]);
    strategyPreviews.clear();
    for(const entry of Object.values(STRATEGY_REGISTRY)){
      if(!entry.create||!entry.manifest.history_contract)continue;
      const preview=entry.create();
      const boot=bootstrapStrategy(preview,historyPlane);
      if(boot.ready&&boot.target)strategyPreviews.set(entry.manifest.id,boot.target);
    }
    tournamentData=runHistoricalTournament({
      spotDataset:historyDataset,futuresDataset,evaluationDays:365,
      costBps:DEFAULT_CONFIG.feeBps+DEFAULT_CONFIG.slippageBps
    });
    shadowData=runDonchianForwardShadow({
      spotDataset:historyDataset,costBps:DEFAULT_CONFIG.feeBps+DEFAULT_CONFIG.slippageBps
    });
    el("historyState").textContent="HISTORY · NEON · SPOT "+historyDataset.count+" THROUGH "+(historyDataset.coverage_end?.slice(0,10)||"—")+" · FUTURES "+futuresDataset.count+" THROUGH "+(futuresDataset.coverage_end?.slice(0,10)||"—");
    renderTournament();renderShadow();setupReplay();
    await Promise.all([recordHistorySnapshot(historyDataset),recordHistorySnapshot(futuresDataset)]);
  }catch(e){
    tournamentData=null;shadowData=null;clearReplay("Replay unavailable.");
    el("historyState").textContent="HISTORY · ERROR";
    el("tournamentState").textContent="TOURNAMENT · UNAVAILABLE";
    addEvent("sell","HISTORY",e.message);
  }
  renderStrategyCatalog();renderTournament();renderShadow();
}

function addEvent(kind,who,msg){
  const sec=Math.floor((Date.now()-started)/1000),m=String(Math.floor(sec/60)).padStart(2,"0"),s=String(sec%60).padStart(2,"0");
  state.events.unshift({kind,who,msg,time:"["+m+":"+s+"]"});state.events=state.events.slice(0,100);state.slowDirty=true;
}
function acceptVisualQuote(quote){
  state.quote=quote;state.targetPrice=quote.last;state.feedState="LIVE";state.feedErrors=0;state.staleLogged=false;
  if(state.displayPrice==null)state.displayPrice=quote.last;
  const now=performance.now();
  if(now-state.lastVisualSampleAt>=VISUAL_SAMPLE_MS||!state.visualHistory.length){
    state.visualHistory.push({last:quote.last,receivedAt:quote.receivedAt});
    if(state.visualHistory.length>180)state.visualHistory.shift();
    state.lastVisualSampleAt=now;state.depthDirty=true;
  }
}
function onFeedStatus(status,detail){
  if(status===state.lastStatus&&!detail)return;
  state.lastStatus=status;
  if(status!=="LIVE")state.feedState=status;
  if(status==="RECONNECTING")addEvent("hold","FEED","WebSocket reconnecting");
  if(status==="ERROR"){
    state.feedErrors++;
    addEvent("sell","FEED",detail||"WebSocket error");
    log?.append("feed.error",{message:detail||"WebSocket error",count:state.feedErrors},state.tick).catch(()=>{});
  }
}
async function boot(){
  clearTimeout(strategyTimer);clearTimeout(syntheticTimer);clearTimeout(ledgerTimer);clearTimeout(controlPollTimer);clearInterval(controlClockTimer);cancelAnimationFrame(rafId);
  try{feed?.close?.()}catch{} if(log)log.close();
  feed=makeFeed();log=new EvidenceLog({endpoint:null});strategy=createStrategy("consensus-six");state=newState();started=Date.now();
  el("feed").innerHTML="";document.querySelector(".mode").textContent=autonomous?"NEON PAPER":feedMode==="live"?"LIVE PAPER":"SYNTHETIC TEST";
  el("shock").disabled=feedMode==="live";el("shock").title=feedMode==="live"?"Shock injection is available only in deterministic synthetic mode.":"";
  el("speed").disabled=feedMode==="live";el("speed").textContent=feedMode==="live"?"STREAMING":"1× SPEED";
  el("run20").hidden=!autonomous;el("stopRun").hidden=true;
  if(autonomous){el("pause").hidden=true;el("speed").hidden=true;el("shock").hidden=true;el("reset").textContent="REFRESH"}
  else{el("run20").hidden=true;el("stopRun").hidden=true}
  addEvent("sys","SYSTEM",autonomous?"Opening Coinbase visualization · Neon owns paper execution":feedMode==="live"?"Opening Coinbase BTC-USD WebSocket":"Deterministic arena initialized");
  await log.append("run.started",{mode:feedMode,config:DEFAULT_CONFIG,product:"BTC-USD",market_transport:feedMode==="live"?"coinbase-websocket":"synthetic",strategy:strategy.manifest},0);
  if(feedMode==="live"){
    feed.start(acceptVisualQuote,onFeedStatus);
    nextStrategyAt=performance.now()+STRATEGY_MS;
    strategyTimer=setTimeout(strategyPulse,STRATEGY_MS);
  }else{
    syntheticTimer=setTimeout(syntheticPulse,20);
  }
  renderSlow();refreshLedger();loadHistoryPlane();if(autonomous){refreshControlStatus();controlClockTimer=setInterval(renderSessionControl,1000)}rafId=requestAnimationFrame(frame);
}
async function strategyPulse(){
  if(feedMode!=="live")return;
  try{
    if(!state.paused){
      const quote=feed.latest();
      if(quote){
        const age=Date.now()-quote.receivedAt;
        if(age>DEFAULT_CONFIG.maxQuoteAgeMs){
          state.feedState="STALE";
          if(!state.staleLogged){
            state.staleLogged=true;addEvent("sell","FEED","Quote stale · "+age+" ms");
            await log.append("feed.error",{message:"stale WebSocket quote",age_ms:age},state.tick);
          }
        }else if(quote.sequence!==state.lastStrategySequence){
          state.lastStrategySequence=quote.sequence;
          if(autonomous)previewSnapshot(quote);
          else await processSnapshot(quote);
        }
      }
    }
  }catch(e){
    state.feedErrors++;state.feedState="ERROR";addEvent("sell","ENGINE",e.message);
    await log.append("feed.error",{message:e.message,count:state.feedErrors},state.tick).catch(()=>{});
  }
  nextStrategyAt+=STRATEGY_MS;
  if(nextStrategyAt<performance.now()-STRATEGY_MS)nextStrategyAt=performance.now()+STRATEGY_MS;
  strategyTimer=setTimeout(strategyPulse,Math.max(50,nextStrategyAt-performance.now()));
}
async function syntheticPulse(){
  if(feedMode!=="synthetic")return;
  try{
    if(!state.paused){
      for(let i=0;i<speed;i++){
        const quote=await feed.next();acceptVisualQuote(quote);await processSnapshot(quote);
      }
    }
  }catch(e){
    state.feedErrors++;state.feedState="ERROR";addEvent("sell","ENGINE",e.message);
    await log.append("feed.error",{message:e.message,count:state.feedErrors},state.tick).catch(()=>{});
  }
  syntheticTimer=setTimeout(syntheticPulse,SYNTHETIC_MS);
}
function previewSnapshot(quote){
  const observation={...quote};
  state.history.push(observation);if(state.history.length>90)state.history.shift();
  strategy.observe(observation);
  const target=strategy.target();
  state.signals=target.explanation?.signals||[];
  state.slowDirty=true;
}

async function processSnapshot(quote){
  state.tick++;
  const observation={...quote};
  state.history.push(observation);if(state.history.length>90)state.history.shift();
  await log.append("market.observation",observation,state.tick);
  markAccount(state.account,observation);

  strategy.observe(observation);
  const target=strategy.target();
  state.signals=target.explanation?.signals||[];

  const now=Date.now();
  let exit=evaluateExit(state.account,observation,target.score,now);
  const position=state.account.position;
  await log.append("strategy.target",{
    strategy_id:target.strategy_id,
    exposure:target.exposure,
    confidence:target.confidence,
    leader:target.leader,
    rationale:target.rationale,
    explanation:target.explanation,
    exit_gate:position?{
      age_ms:Math.max(0,now-position.openedAt),
      flip_confirmations:position.flipConfirmations||0,
      required_confirmations:DEFAULT_CONFIG.exitFlipConfirmations,
      flip_threshold:DEFAULT_CONFIG.exitFlipThreshold,
      min_hold_ms:DEFAULT_CONFIG.minHoldMs
    }:null
  },state.tick);

  const killed=enforceKillSwitch(state.account);
  if(killed&&state.account.position)exit="kill switch: "+killed;
  if(exit){
    const fill=closePaper(state.account,observation,exit,now);
    addEvent(fill.net>=0?"buy":"sell","CLOSED",exit+" · "+(fill.net>=0?"+":"")+"$"+fill.net.toFixed(4));
    await log.append("execution.fill",{kind:"close",strategy_id:target.strategy_id,...fill,equity:state.account.equity},state.tick);
  }else if(!state.account.position){
    const intent={
      strategy_id:target.strategy_id,
      score:target.score,
      target_exposure:target.exposure,
      confidence:target.confidence,
      leader:target.leader
    };
    const risk=riskDecision(state.account,observation,intent,now);
    if(risk.halt){state.account.halted=true;state.account.haltReason=risk.reason}
    await log.append("risk.decision",{intent,...risk},state.tick);
    if(risk.allowed){
      const fill=openPaper(state.account,observation,intent,risk,now);
      addEvent(fill.side==="BUY"?"buy":"sell",target.leader,(fill.side==="BUY"?"LONG":"SHORT")+" · $"+fill.notional.toFixed(2)+" notional");
      await log.append("execution.fill",{kind:"open",strategy_id:target.strategy_id,...fill,score:target.score,target_exposure:target.exposure},state.tick);
    }else if(state.tick%5===0)addEvent("hold",target.leader,"HOLD · "+risk.reason);
  }
  markAccount(state.account,observation);enforceKillSwitch(state.account);
  state.equities.push(state.account.equity);if(state.equities.length>90)state.equities.shift();
  state.slowDirty=true;
}
function liveEquity(price){
  const a=state.account;
  if(!a.position||!Number.isFinite(price))return a.cash;
  const p=a.position;return a.cash+p.direction*p.qty*(price-p.entryPrice);
}
function renderAgents(){
  const map=new Map(state.signals.map(x=>[x.id,x]));
  el("agents").innerHTML=AGENTS.map(d=>{const s=map.get(d.id)||{vote:"WAIT",raw:0,reason:"awaiting tape"};
    return '<article class="agent '+(Math.abs(s.raw)>.55?"active ":"")+d.id+'"><div class="agentTop"><div class="face">'+d.glyph+'</div><div class="vote">'+s.vote+'</div></div><div class="name">'+d.name+'</div><div class="role">owns the '+d.role+'</div><div class="conviction"><i style="width:'+Math.abs(s.raw)*100+'%"></i></div><div class="reason">'+s.reason+"</div></article>";
  }).join("");
}
function renderSlow(){
  const a=state.account,total=a.wins+a.losses;
  el("realized").textContent=(a.realized>=0?"+":"")+"$"+a.realized.toFixed(2);el("realized").className="value "+(a.realized>=0?"pos":"neg");
  el("winrate").textContent=total?(a.wins/total*100).toFixed(1)+"%":"—";el("record").textContent=a.wins+"W / "+a.losses+"L";
  const risk=a.halted?"HALTED":a.maxdd>DEFAULT_CONFIG.maxDrawdownPct*.5?"CAUTION":"NORMAL";
  el("riskState").textContent=risk;el("riskState").className="value "+(risk==="NORMAL"?"pos":risk==="HALTED"?"neg":"");
  el("exposure").textContent=a.position?(a.position.direction>0?"long":"short")+" · "+(DEFAULT_CONFIG.maxExposurePct*100).toFixed(0)+"% max exposure":"flat · 0% exposure";
  el("cycle").textContent="#"+String(state.tick).padStart(3,"0");el("resolved").textContent=total+" RESOLVED";el("trades").textContent=a.trades;el("drawdown").textContent=(a.maxdd*100).toFixed(1)+"%";
  el("edge").textContent=total?(a.realized/total/DEFAULT_CONFIG.initialEquity*100).toFixed(2)+"%":"0.00%";
  el("bestworst").textContent=a.returns.length?"+$"+Math.max(...a.returns).toFixed(3)+" / $"+Math.min(...a.returns).toFixed(3):"— / —";
  el("runway").textContent=a.halted?"HALTED":a.maxdd>.04?Math.max(1,Math.round(a.equity/(a.maxdd*DEFAULT_CONFIG.initialEquity/10)))+" cycles":"∞";
  el("feed").innerHTML=state.events.map(e=>'<div class="event"><time>'+e.time+'</time><span><b class="'+e.kind+'">'+e.who+"</b> "+e.msg+"</span></div>").join("");
  renderAgents();state.slowDirty=false;
}
function renderRealtime(){
  const a=state.account,q=state.quote,price=state.displayPrice,equity=liveEquity(price);
  const p=equity-DEFAULT_CONFIG.initialEquity,pct=p/DEFAULT_CONFIG.initialEquity*100;
  el("balance").textContent="$"+equity.toFixed(2);el("pnl").textContent=(p>=0?"+":"")+"$"+p.toFixed(2);el("pnl").className="value "+(p>=0?"pos":"neg");
  el("pnlPct").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"%";
  const sec=Math.floor((Date.now()-started)/1000);el("uptime").textContent=[Math.floor(sec/3600),Math.floor(sec/60)%60,sec%60].map(x=>String(x).padStart(2,"0")).join(":");
  if(q&&Number.isFinite(price)){
    el("badge").textContent="BTC "+price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const spread=(q.ask-q.bid)/q.last*10000,look=state.history.at(-8)?.last??price,recent=look?(price-look)/look*100:0;
    el("momentum").textContent=(recent>=0?"+":"")+recent.toFixed(2)+"%";el("spread").textContent=spread.toFixed(3)+" bps";el("vol").textContent=(12+Math.abs(recent)*8).toFixed(1)+"%";
    el("regime").textContent=state.feedState+(feedMode==="live"?" · WS":" · TEST");
  }
}
function renderDepth(){
  const q=state.quote;if(!q){el("depth").innerHTML="";return}
  const total=Math.max(q.bidSize+q.askSize,1e-9),bid=q.bidSize/total,ask=q.askSize/total;let bars="";
  for(let i=0;i<36;i++){const isAsk=i>=18,base=isAsk?ask:bid,h=18+base*55+((i*7)%13);bars+='<i class="bar '+(isAsk?"ask":"")+'" style="height:'+Math.min(95,h)+'%"></i>'}
  el("depth").innerHTML=bars;
}
function draw(){
  const c=el("chart"),dpr=Math.min(devicePixelRatio||1,2),w=c.clientWidth,h=c.clientHeight;
  const pw=Math.max(1,Math.round(w*dpr)),ph=Math.max(1,Math.round(h*dpr));
  if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph}
  const x=c.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
  x.strokeStyle="#172026";x.lineWidth=1;for(let i=0;i<5;i++){const y=18+i*(h-44)/4;x.beginPath();x.moveTo(46,y);x.lineTo(w-10,y);x.stroke()}
  const prices=state.visualHistory.map(v=>v.last);
  if(Number.isFinite(state.displayPrice)){if(prices.length)prices[prices.length-1]=state.displayPrice;else prices.push(state.displayPrice)}
  const eq=state.equities.slice();eq.push(liveEquity(state.displayPrice));
  const line=(arr,color,width)=>{if(arr.length<2)return;const min=Math.min(...arr),max=Math.max(...arr),span=max-min||1;x.strokeStyle=color;x.lineWidth=width;x.beginPath();arr.forEach((v,i)=>{const px=46+i*(w-58)/(arr.length-1),py=18+(max-v)/span*(h-50);i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke()};
  line(prices,"#718087",1);line(eq,"#70ff9f",2);
}
function frame(ts){
  if(!state)return;
  updateReplayPlayback(ts);
  const dt=state.lastFrameAt?Math.min(100,ts-state.lastFrameAt):16;state.lastFrameAt=ts;
  if(Number.isFinite(state.targetPrice)){
    if(state.displayPrice==null||reducedMotion)state.displayPrice=state.targetPrice;
    else{
      const alpha=1-Math.exp(-dt/110);
      state.displayPrice+= (state.targetPrice-state.displayPrice)*alpha;
      if(Math.abs(state.targetPrice-state.displayPrice)<.0001)state.displayPrice=state.targetPrice;
    }
  }
  renderRealtime();
  if(state.slowDirty)renderSlow();
  if(state.depthDirty&&ts-state.lastDepthRenderAt>=DEPTH_RENDER_MS){renderDepth();state.depthDirty=false;state.lastDepthRenderAt=ts}
  draw();rafId=requestAnimationFrame(frame);
}
el("pause").onclick=()=>{
  state.paused=!state.paused;el("pause").textContent=state.paused?"RESUME":"PAUSE";
  addEvent("sys","SYSTEM",state.paused?"Strategy clock paused":"Strategy clock resumed");
  log.append("control",{action:state.paused?"pause":"resume"},state.tick).catch(()=>{});
};
el("speed").onclick=()=>{if(feedMode!=="synthetic")return;speed=speed===1?2:speed===2?4:1;el("speed").textContent=speed+"× SPEED"};
el("shock").onclick=()=>{if(feedMode!=="synthetic")return;const shock=feed.shock();addEvent("sys","SHOCK",(shock>0?"+":"")+(shock*100).toFixed(2)+"% event queued")};
el("replayPlay").onclick=()=>startReplay(true);
el("replayPause").onclick=toggleReplayPause;
el("replayStrategy").onchange=e=>{replaySelectedId=e.target.value;renderReplay()};
el("replayScrub").oninput=e=>{replayPlaying=false;el("replayPause").textContent="RESUME";replayIndex=Number(e.target.value)||0;renderReplay()};
el("run20").onclick=()=>setSession("start");
el("stopRun").onclick=()=>setSession("stop");
el("reset").onclick=boot;
window.addEventListener("resize",()=>{state.depthDirty=true;drawTournamentChart();drawReplayChart()});
window.addEventListener("pagehide",()=>{try{feed?.close?.();log?.close?.()}catch{}},{once:true});
boot();
