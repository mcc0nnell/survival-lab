const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:0;

function sampleStdev(xs){
  if(xs.length<2)return 0;
  const m=mean(xs);
  return Math.sqrt(xs.reduce((s,x)=>s+(x-m)*(x-m),0)/(xs.length-1));
}

function validateRaw(rawExposure){
  const x=Number(rawExposure);
  if(!Number.isFinite(x)||x<-1||x>1)throw new RangeError("compounder requires raw exposure in [-1, 1]");
  return x;
}

function applyBand(target,previous,band){
  if(!Number.isFinite(previous))return target;
  if(target===0||previous===0||Math.sign(target)!==Math.sign(previous))return target;
  return Math.abs(target-previous)<Math.max(0,band)?previous:target;
}

function result(exposure,scale,details={}){
  return {exposure,scale,...details};
}

export function createFixedFractionalCompounder({fraction=.75,maxExposure=1}={}){
  const f=clamp(Number(fraction)||0,0,1),cap=clamp(Number(maxExposure)||1,0,1);
  return {
    id:"fixed-fractional",
    config:{fraction:f,max_exposure:cap},
    reset(){},
    next({rawExposure}){
      const raw=validateRaw(rawExposure),scale=Math.min(f,cap);
      return result(clamp(raw*scale,-cap,cap),scale);
    }
  };
}

export function createVolTargetCompounder({
  targetVol=.35,lookback=30,annualPeriods=365,minScale=.25,maxScale=1,noTradeBand=.10,maxExposure=1
}={}){
  const returns=[],n=Math.max(2,Math.floor(lookback)),target=Math.max(0,Number(targetVol)||0);
  const floor=clamp(Number(minScale)||0,0,1),ceiling=clamp(Number(maxScale)||1,floor,1),cap=clamp(Number(maxExposure)||1,0,1);
  return {
    id:"vol-target",
    config:{target_vol:target,lookback:n,annual_periods:annualPeriods,min_scale:floor,max_scale:ceiling,no_trade_band:noTradeBand,max_exposure:cap},
    reset(){returns.length=0},
    next({rawExposure,assetReturn,previousExposure=0}){
      const raw=validateRaw(rawExposure);
      if(Number.isFinite(assetReturn)){returns.push(Number(assetReturn));if(returns.length>n)returns.shift()}
      const realized=returns.length>=2?sampleStdev(returns)*Math.sqrt(annualPeriods):null;
      const scale=realized>0?clamp(target/realized,floor,ceiling):ceiling;
      let exposure=clamp(raw*scale,-cap,cap);
      exposure=applyBand(exposure,previousExposure,noTradeBand);
      return result(exposure,scale,{realized_vol:realized});
    }
  };
}

export function createFractionalKellyCompounder({
  fraction=.25,lookback=90,minSamples=30,initialScale=.5,maxScale=1,noTradeBand=.10,maxExposure=1
}={}){
  const returns=[],n=Math.max(2,Math.floor(lookback)),required=Math.max(2,Math.floor(minSamples));
  const kf=clamp(Number(fraction)||0,0,1),initial=clamp(Number(initialScale)||0,0,1);
  const ceiling=clamp(Number(maxScale)||1,0,1),cap=clamp(Number(maxExposure)||1,0,1);
  return {
    id:"quarter-kelly",
    config:{kelly_fraction:kf,lookback:n,min_samples:required,initial_scale:initial,max_scale:ceiling,no_trade_band:noTradeBand,max_exposure:cap},
    reset(){returns.length=0},
    next({rawExposure,signalReturn,previousExposure=0}){
      const raw=validateRaw(rawExposure);
      if(Number.isFinite(signalReturn)){returns.push(Number(signalReturn));if(returns.length>n)returns.shift()}
      let fullKelly=null,scale=initial;
      if(returns.length>=required){
        const m=mean(returns),sd=sampleStdev(returns),variance=sd*sd;
        fullKelly=variance>0?m/variance:0;
        scale=clamp(kf*Math.max(0,fullKelly),0,ceiling);
      }
      let exposure=clamp(raw*scale,-cap,cap);
      exposure=applyBand(exposure,previousExposure,noTradeBand);
      return result(exposure,scale,{full_kelly:fullKelly,samples:returns.length});
    }
  };
}

export function createHybridCompounder({
  baseFraction=1,drawdownStart=.05,drawdownFull=.15,minFraction=.25,noTradeBand=.10,maxExposure=1
}={}){
  const base=clamp(Number(baseFraction)||0,0,1),start=clamp(Number(drawdownStart)||0,0,.99);
  const full=clamp(Number(drawdownFull)||0,start+.000001,.999999),floor=clamp(Number(minFraction)||0,0,base);
  const cap=clamp(Number(maxExposure)||1,0,1);
  let peak=1;
  return {
    id:"hybrid-fractional-drawdown-band",
    config:{base_fraction:base,drawdown_start:start,drawdown_full:full,min_fraction:floor,no_trade_band:noTradeBand,max_exposure:cap},
    reset({equity=1}={}){peak=Math.max(0,Number(equity)||1)},
    next({rawExposure,equity=1,previousExposure=0}){
      const raw=validateRaw(rawExposure),eq=Math.max(0,Number(equity)||0);
      peak=Math.max(peak,eq);
      const drawdown=peak>0?clamp((peak-eq)/peak,0,1):0;
      let scale=base;
      if(drawdown>start){
        const t=clamp((drawdown-start)/(full-start),0,1);
        scale=base-(base-floor)*t;
      }
      let exposure=clamp(raw*scale,-cap,cap);
      exposure=applyBand(exposure,previousExposure,noTradeBand);
      return result(exposure,scale,{drawdown,peak});
    }
  };
}

export function createDefaultCompounders(){
  return [
    createFixedFractionalCompounder(),
    createVolTargetCompounder(),
    createFractionalKellyCompounder(),
    createHybridCompounder()
  ];
}
