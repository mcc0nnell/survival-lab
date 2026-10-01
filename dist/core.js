export const DEFAULT_CONFIG = Object.freeze({
  initialEquity: 20,
  entryThreshold: 0.13,
  exitFlipThreshold: 0.15,
  takeProfitPct: 0.012,
  stopLossPct: 0.008,
  maxExposurePct: 0.25,
  maxNotionalUsd: 5,
  maxDrawdownPct: 0.12,
  maxCumulativeLossUsd: 2.50,
  maxQuoteAgeMs: 5000,
  minOrderIntervalMs: 5000,
  feeBps: 20,
  slippageBps: 1.5
});

export const AGENTS = Object.freeze([
  {id:"kesto",name:"KESTO",role:"trend",glyph:"●"},
  {id:"orven",name:"ORVEN",role:"mean revert",glyph:"●"},
  {id:"brava",name:"BRAVA",role:"breakout",glyph:"◆"},
  {id:"mirax",name:"MIRAX",role:"volatility",glyph:"●"},
  {id:"duska",name:"DUSKA",role:"order flow",glyph:"▲"},
  {id:"novia",name:"NOVIA",role:"liquidity",glyph:"●"}
]);

const clamp=(n,min=-1,max=1)=>Math.max(min,Math.min(max,n));
const mid=q=>(q.bid+q.ask)/2;

export function createAccount(cfg=DEFAULT_CONFIG){
  return {cash:cfg.initialEquity,equity:cfg.initialEquity,realized:0,position:null,
    peak:cfg.initialEquity,maxdd:0,wins:0,losses:0,returns:[],halted:false,
    haltReason:null,lastOrderAt:0,trades:0};
}

export function computeSignals(history, quote){
  const prices=history.map(x=>x.last);
  const last=quote.last;
  const prev=prices.at(-2) ?? last;
  const ret=prev ? (last-prev)/prev : 0;
  const look8=prices.at(-8) ?? last;
  const mom=look8 ? (last-look8)/look8 : 0;
  const recent=prices.slice(-20);
  const hi=recent.length?Math.max(...recent):last;
  const lo=recent.length?Math.min(...recent):last;
  const span=Math.max(hi-lo,last*1e-9);
  const breakout=((last-lo)/span-.5)*2;
  const rs=prices.slice(-12).map((p,i,a)=>i&&a[i-1]?(p-a[i-1])/a[i-1]:0).slice(1);
  const vol=rs.length?Math.sqrt(rs.reduce((s,r)=>s+r*r,0)/rs.length):0;
  const spreadBps=last ? (quote.ask-quote.bid)/last*10000 : 0;
  const depth=(quote.bidSize||0)+(quote.askSize||0);
  const imbalance=depth ? ((quote.bidSize||0)-(quote.askSize||0))/depth : 0;
  const aggressor=quote.aggressor||0;
  const raws=[
    clamp(mom*30),
    clamp(-ret*45),
    clamp(Math.abs(breakout)>.72?Math.sign(breakout)*Math.min(1,Math.abs(breakout)):0),
    clamp(vol>.004?-Math.sign(ret)*Math.min(.6,vol*75):0),
    clamp(aggressor*.42),
    clamp(imbalance*.75)
  ];
  const reasons=[
    mom>=0?"trend rising":"trend falling",
    ret>=0?"fade extension":"buy dislocation",
    Math.abs(breakout)>.72?"range boundary break":"inside range",
    vol>.004?"vol spike: lean defensive":"vol contained",
    aggressor>0?"buyer-initiated flow":aggressor<0?"seller-initiated flow":"flow neutral",
    spreadBps>8?"spread wide":imbalance>=0?"bid depth stronger":"ask depth stronger"
  ];
  return AGENTS.map((d,i)=>({...d,raw:raws[i],vote:raws[i]>.18?"BUY":raws[i]<-.18?"SELL":"HOLD",reason:reasons[i]}));
}

export function consensus(signals){
  const score=signals.reduce((s,x)=>s+x.raw,0)/Math.max(1,signals.length);
  const leader=[...signals].sort((a,b)=>Math.abs(b.raw)-Math.abs(a.raw))[0];
  return {score,leader};
}

export function markAccount(account, quote){
  if(account.position){
    const p=account.position;
    const unrealized=p.direction*p.qty*(mid(quote)-p.entryPrice);
    account.equity=account.cash+unrealized;
  } else account.equity=account.cash;
  account.peak=Math.max(account.peak,account.equity);
  account.maxdd=Math.max(account.maxdd,account.peak?Math.max(0,(account.peak-account.equity)/account.peak):0);
  return account;
}

function marketFill(side, quote, cfg){
  const slip=cfg.slippageBps/10000;
  return side==="BUY"?quote.ask*(1+slip):quote.bid*(1-slip);
}

export function riskDecision(account, quote, intent, now=Date.now(), cfg=DEFAULT_CONFIG){
  if(account.halted) return {allowed:false,reason:account.haltReason||"risk halted"};
  if(!Number.isFinite(quote?.bid)||!Number.isFinite(quote?.ask)||quote.bid<=0||quote.ask<quote.bid)
    return {allowed:false,reason:"invalid quote"};
  if(now-(quote.receivedAt||0)>cfg.maxQuoteAgeMs) return {allowed:false,reason:"stale quote"};
  if(account.maxdd>=cfg.maxDrawdownPct) return {allowed:false,reason:"max drawdown reached",halt:true};
  if(cfg.initialEquity-account.cash>=cfg.maxCumulativeLossUsd) return {allowed:false,reason:"loss budget reached",halt:true};
  if(now-account.lastOrderAt<cfg.minOrderIntervalMs) return {allowed:false,reason:"order rate limit"};
  if(account.position) return {allowed:false,reason:"position already open"};
  if(Math.abs(intent.score)<cfg.entryThreshold) return {allowed:false,reason:"consensus below threshold"};
  const notional=Math.min(account.equity*cfg.maxExposurePct,cfg.maxNotionalUsd);
  if(notional<=0) return {allowed:false,reason:"no risk budget",halt:true};
  return {allowed:true,reason:"risk approved",notional};
}

export function openPaper(account, quote, intent, risk, now=Date.now(), cfg=DEFAULT_CONFIG){
  if(!risk.allowed) throw new Error("paper execution requires risk authorization");
  const direction=Math.sign(intent.score)||1;
  const side=direction>0?"BUY":"SELL";
  const fill=marketFill(side,quote,cfg);
  const qty=risk.notional/fill;
  const fee=risk.notional*cfg.feeBps/10000;
  account.cash-=fee;
  account.realized-=fee;
  account.position={direction,qty,entryPrice:fill,entryNotional:risk.notional,entryFee:fee,openedAt:now};
  account.lastOrderAt=now;
  account.trades++;
  markAccount(account,quote);
  return {side,fill,qty,notional:risk.notional,fee};
}

export function closePaper(account, quote, reason="exit", now=Date.now(), cfg=DEFAULT_CONFIG){
  if(!account.position) return null;
  const p=account.position;
  const side=p.direction>0?"SELL":"BUY";
  const fill=marketFill(side,quote,cfg);
  const gross=p.direction*p.qty*(fill-p.entryPrice);
  const exitNotional=p.qty*fill;
  const fee=exitNotional*cfg.feeBps/10000;
  const net=gross-fee;
  account.cash+=net;
  account.realized+=net;
  account.returns.push(gross-p.entryFee-fee);
  gross-p.entryFee-fee>=0?account.wins++:account.losses++;
  account.position=null;
  account.lastOrderAt=now;
  markAccount(account,quote);
  return {side,fill,qty:p.qty,gross,fee,net:net-p.entryFee,reason};
}

export function evaluateExit(account, quote, score, cfg=DEFAULT_CONFIG){
  if(!account.position) return null;
  const p=account.position;
  const u=p.direction*(mid(quote)-p.entryPrice)/p.entryPrice;
  if(Math.sign(score)!==p.direction&&Math.abs(score)>cfg.exitFlipThreshold) return "consensus flip";
  if(u>=cfg.takeProfitPct) return "take profit";
  if(u<=-cfg.stopLossPct) return "risk stop";
  return null;
}

export function enforceKillSwitch(account, cfg=DEFAULT_CONFIG){
  const dd=account.maxdd>=cfg.maxDrawdownPct;
  const loss=cfg.initialEquity-account.cash>=cfg.maxCumulativeLossUsd;
  if(dd||loss){
    account.halted=true;
    account.haltReason=dd?"max drawdown":"loss budget";
    return account.haltReason;
  }
  return null;
}
