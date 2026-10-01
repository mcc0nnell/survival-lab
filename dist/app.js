import {DEFAULT_CONFIG,AGENTS,createAccount,computeSignals,consensus,markAccount,riskDecision,openPaper,closePaper,evaluateExit,enforceKillSwitch} from "./core.js";
import {CoinbaseFeed,SyntheticFeed} from "./feed.js";
import {EvidenceLog} from "./evidence.js";

const el=id=>document.getElementById(id);
const feedMode=new URLSearchParams(location.search).get("feed")==="synthetic"?"synthetic":"live";
const evidenceEndpoint=document.querySelector('meta[name="survival-evidence-endpoint"]')?.content||null;
let feed,log,state,timer,started,speed=1;

function newState(){
  return {tick:0,account:createAccount(),history:[],equities:Array(70).fill(DEFAULT_CONFIG.initialEquity),events:[],signals:[],quote:null,
    paused:false,feedErrors:0,feedState:"CONNECTING"};
}
function makeFeed(){return feedMode==="synthetic"?new SyntheticFeed():new CoinbaseFeed("BTC-USD")}
function addEvent(kind,who,msg){
  const sec=Math.floor((Date.now()-started)/1000),m=String(Math.floor(sec/60)).padStart(2,"0"),s=String(sec%60).padStart(2,"0");
  state.events.unshift({kind,who,msg,time:"["+m+":"+s+"]"});state.events=state.events.slice(0,100);
}
async function boot(){
  clearTimeout(timer);if(log)log.close();
  feed=makeFeed();log=new EvidenceLog({endpoint:evidenceEndpoint});state=newState();started=Date.now();
  el("feed").innerHTML="";document.querySelector(".mode").textContent=feedMode==="live"?"LIVE PAPER":"SYNTHETIC TEST";
  el("shock").disabled=feedMode==="live";el("shock").title=feedMode==="live"?"Shock injection is available only in deterministic synthetic mode.":"";
  el("speed").disabled=feedMode==="live";el("speed").textContent=feedMode==="live"?"REAL TIME":"1× SPEED";
  addEvent("sys","SYSTEM",feedMode==="live"?"Connecting to public BTC-USD market data":"Deterministic arena initialized");
  await log.append("run.started",{mode:feedMode,config:DEFAULT_CONFIG,product:"BTC-USD"},0);
  render();schedule(20);
}
function schedule(ms){clearTimeout(timer);timer=setTimeout(loop,ms)}
async function loop(){
  if(state.paused){schedule(250);return}
  try{
    const rounds=feedMode==="synthetic"?speed:1;
    for(let i=0;i<rounds;i++) await step();
    state.feedErrors=0;state.feedState="LIVE";
  }catch(e){
    state.feedErrors++;state.feedState="STALE";
    addEvent("sell","FEED","Market data error · "+e.message);
    await log.append("feed.error",{message:e.message,count:state.feedErrors},state.tick);
  }
  render();schedule(feedMode==="synthetic"?900:2000);
}
async function step(){
  const quote=await feed.next();state.quote=quote;state.tick++;
  state.history.push(quote);if(state.history.length>90)state.history.shift();
  await log.append("market.observation",quote,state.tick);
  markAccount(state.account,quote);
  const signals=computeSignals(state.history,quote), vote=consensus(signals);
  state.signals=signals;
  await log.append("agent.consensus",{score:vote.score,leader:vote.leader.name,signals:signals.map(x=>({id:x.id,raw:x.raw,vote:x.vote}))},state.tick);
  let exit=evaluateExit(state.account,quote,vote.score);
  const killed=enforceKillSwitch(state.account);
  if(killed&&state.account.position) exit="kill switch: "+killed;
  if(exit){
    const fill=closePaper(state.account,quote,exit,Date.now());
    addEvent(fill.net>=0?"buy":"sell","CLOSED",exit+" · "+(fill.net>=0?"+":"")+"$"+fill.net.toFixed(4));
    await log.append("execution.fill",{kind:"close",...fill,equity:state.account.equity},state.tick);
  }else if(!state.account.position){
    const intent={score:vote.score,leader:vote.leader.name};
    const risk=riskDecision(state.account,quote,intent,Date.now());
    if(risk.halt){state.account.halted=true;state.account.haltReason=risk.reason}
    await log.append("risk.decision",{intent,...risk},state.tick);
    if(risk.allowed){
      const fill=openPaper(state.account,quote,intent,risk,Date.now());
      addEvent(fill.side==="BUY"?"buy":"sell",vote.leader.name,(fill.side==="BUY"?"LONG":"SHORT")+" · $"+fill.notional.toFixed(2)+" notional");
      await log.append("execution.fill",{kind:"open",...fill,score:vote.score},state.tick);
    }else if(state.tick%5===0) addEvent("hold",vote.leader.name,"HOLD · "+risk.reason);
  }
  markAccount(state.account,quote);enforceKillSwitch(state.account);
  state.equities.push(state.account.equity);if(state.equities.length>90)state.equities.shift();
}
function renderAgents(){
  const map=new Map(state.signals.map(x=>[x.id,x]));
  el("agents").innerHTML=AGENTS.map(d=>{const s=map.get(d.id)||{vote:"WAIT",raw:0,reason:"awaiting tape"};
    return '<article class="agent '+(Math.abs(s.raw)>.55?"active ":"")+d.id+'"><div class="agentTop"><div class="face">'+d.glyph+'</div><div class="vote">'+s.vote+'</div></div><div class="name">'+d.name+'</div><div class="role">owns the '+d.role+'</div><div class="conviction"><i style="width:'+Math.abs(s.raw)*100+'%"></i></div><div class="reason">'+s.reason+"</div></article>";
  }).join("");
}
function render(){
  const a=state.account,q=state.quote,p=a.equity-DEFAULT_CONFIG.initialEquity,pct=p/DEFAULT_CONFIG.initialEquity*100,total=a.wins+a.losses;
  el("balance").textContent="$"+a.equity.toFixed(2);el("pnl").textContent=(p>=0?"+":"")+"$"+p.toFixed(2);el("pnl").className="value "+(p>=0?"pos":"neg");
  el("pnlPct").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"%";el("realized").textContent=(a.realized>=0?"+":"")+"$"+a.realized.toFixed(2);
  el("realized").className="value "+(a.realized>=0?"pos":"neg");el("winrate").textContent=total?(a.wins/total*100).toFixed(1)+"%":"—";el("record").textContent=a.wins+"W / "+a.losses+"L";
  const risk=a.halted?"HALTED":a.maxdd>DEFAULT_CONFIG.maxDrawdownPct*.5?"CAUTION":"NORMAL";el("riskState").textContent=risk;el("riskState").className="value "+(risk==="NORMAL"?"pos":risk==="HALTED"?"neg":"");
  el("exposure").textContent=a.position?(a.position.direction>0?"long":"short")+" · "+(DEFAULT_CONFIG.maxExposurePct*100).toFixed(0)+"% max exposure":"flat · 0% exposure";
  const sec=Math.floor((Date.now()-started)/1000);el("uptime").textContent=[Math.floor(sec/3600),Math.floor(sec/60)%60,sec%60].map(x=>String(x).padStart(2,"0")).join(":");
  el("cycle").textContent="#"+String(state.tick).padStart(3,"0");el("resolved").textContent=total+" RESOLVED";el("trades").textContent=a.trades;el("drawdown").textContent=(a.maxdd*100).toFixed(1)+"%";
  el("edge").textContent=total?(a.realized/total/DEFAULT_CONFIG.initialEquity*100).toFixed(2)+"%":"0.00%";
  el("bestworst").textContent=a.returns.length?"+$"+Math.max(...a.returns).toFixed(3)+" / $"+Math.min(...a.returns).toFixed(3):"— / —";
  el("runway").textContent=a.halted?"HALTED":a.maxdd>.04?Math.max(1,Math.round(a.equity/(a.maxdd*DEFAULT_CONFIG.initialEquity/10)))+" cycles":"∞";
  if(q){
    el("badge").textContent="BTC "+q.last.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const spread=(q.ask-q.bid)/q.last*10000,prices=state.history.map(x=>x.last),look=prices.at(-8)||q.last,recent=(q.last-look)/look*100;
    el("momentum").textContent=(recent>=0?"+":"")+recent.toFixed(2)+"%";el("spread").textContent=spread.toFixed(2)+" bps";el("vol").textContent=(12+Math.abs(recent)*8).toFixed(1)+"%";
    el("regime").textContent=state.feedState+(feedMode==="live"?" · CB":" · TEST");
  }
  el("feed").innerHTML=state.events.map(e=>'<div class="event"><time>'+e.time+'</time><span><b class="'+e.kind+'">'+e.who+"</b> "+e.msg+"</span></div>").join("");
  renderAgents();renderDepth();draw();
}
function renderDepth(){
  const q=state.quote;if(!q){el("depth").innerHTML="";return}
  const total=Math.max(q.bidSize+q.askSize,1e-9),bid=q.bidSize/total,ask=q.askSize/total;let bars="";
  for(let i=0;i<36;i++){const isAsk=i>=18,base=isAsk?ask:bid,h=18+base*55+((i*7)%13);bars+='<i class="bar '+(isAsk?"ask":"")+'" style="height:'+Math.min(95,h)+'%"></i>'}
  el("depth").innerHTML=bars;
}
function draw(){
  const c=el("chart"),dpr=Math.min(devicePixelRatio||1,2),w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;const x=c.getContext("2d");x.scale(dpr,dpr);x.clearRect(0,0,w,h);
  x.strokeStyle="#172026";for(let i=0;i<5;i++){const y=18+i*(h-44)/4;x.beginPath();x.moveTo(46,y);x.lineTo(w-10,y);x.stroke()}
  const prices=state.history.map(v=>v.last),eq=state.equities;
  const line=(arr,color,width)=>{if(arr.length<2)return;const min=Math.min(...arr),max=Math.max(...arr),span=max-min||1;x.strokeStyle=color;x.lineWidth=width;x.beginPath();arr.forEach((v,i)=>{const px=46+i*(w-58)/(arr.length-1),py=18+(max-v)/span*(h-50);i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke()};
  line(prices,"#718087",1);line(eq,"#70ff9f",2);
}
el("pause").onclick=()=>{state.paused=!state.paused;el("pause").textContent=state.paused?"RESUME":"PAUSE";addEvent("sys","SYSTEM",state.paused?"Arena paused":"Arena resumed");render()};
el("speed").onclick=()=>{if(feedMode!=="synthetic")return;speed=speed===1?2:speed===2?4:1;el("speed").textContent=speed+"× SPEED"};
el("shock").onclick=()=>{if(feedMode!=="synthetic")return;const shock=feed.shock();addEvent("sys","SHOCK",(shock>0?"+":"")+(shock*100).toFixed(2)+"% event queued")};
el("reset").onclick=boot;window.addEventListener("resize",draw);boot();
