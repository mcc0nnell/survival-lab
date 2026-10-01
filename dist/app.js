import {DEFAULT_CONFIG,AGENTS,createAccount,markAccount,riskDecision,openPaper,closePaper,evaluateExit,enforceKillSwitch} from "./core.js";
import {createStrategy} from "./strategies.js";
import {CoinbaseFeed,SyntheticFeed} from "./feed.js";
import {EvidenceLog} from "./evidence.js";

const el=id=>document.getElementById(id);
const feedMode=new URLSearchParams(location.search).get("feed")==="synthetic"?"synthetic":"live";
const evidenceEndpoint=document.querySelector('meta[name="survival-evidence-endpoint"]')?.content||null;
const STRATEGY_MS=1000, SYNTHETIC_MS=900, VISUAL_SAMPLE_MS=80, DEPTH_RENDER_MS=100;
const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
let feed,log,state,strategy,strategyTimer,syntheticTimer,rafId,started,speed=1,nextStrategyAt=0;

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
  clearTimeout(strategyTimer);clearTimeout(syntheticTimer);cancelAnimationFrame(rafId);
  try{feed?.close?.()}catch{} if(log)log.close();
  feed=makeFeed();log=new EvidenceLog({endpoint:evidenceEndpoint});strategy=createStrategy("consensus-six");state=newState();started=Date.now();
  el("feed").innerHTML="";document.querySelector(".mode").textContent=feedMode==="live"?"LIVE PAPER":"SYNTHETIC TEST";
  el("shock").disabled=feedMode==="live";el("shock").title=feedMode==="live"?"Shock injection is available only in deterministic synthetic mode.":"";
  el("speed").disabled=feedMode==="live";el("speed").textContent=feedMode==="live"?"STREAMING":"1× SPEED";
  addEvent("sys","SYSTEM",feedMode==="live"?"Opening Coinbase BTC-USD WebSocket":"Deterministic arena initialized");
  await log.append("run.started",{mode:feedMode,config:DEFAULT_CONFIG,product:"BTC-USD",market_transport:feedMode==="live"?"coinbase-websocket":"synthetic",strategy:strategy.manifest},0);
  if(feedMode==="live"){
    feed.start(acceptVisualQuote,onFeedStatus);
    nextStrategyAt=performance.now()+STRATEGY_MS;
    strategyTimer=setTimeout(strategyPulse,STRATEGY_MS);
  }else{
    syntheticTimer=setTimeout(syntheticPulse,20);
  }
  renderSlow();rafId=requestAnimationFrame(frame);
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
          await processSnapshot(quote);
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
el("reset").onclick=boot;
window.addEventListener("resize",()=>{state.depthDirty=true});
window.addEventListener("pagehide",()=>{try{feed?.close?.();log?.close?.()}catch{}},{once:true});
boot();
