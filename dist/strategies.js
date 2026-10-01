import {AGENTS,computeSignals,consensus} from "./core.js";
import {createCartridge,validateManifest} from "./cartridge.js";

export const CONSENSUS_SIX_MANIFEST=validateManifest({
  id:"consensus-six",name:"Consensus Six",version:"1.0.0",
  universe:["BTC-USD"],sampling:"1s",lookback:"90 observations",
  rebalance:"event-driven through common risk/execution gate",
  output:"target_exposure",research:["transparent rule ensemble"],status:"active"
});

export function createConsensusSix(){
  return createCartridge({
    manifest:CONSENSUS_SIX_MANIFEST,
    createState:()=>({history:[],signals:[],vote:{score:0,leader:AGENTS[0]},last:null}),
    observe(state,observation){
      state.history.push({...observation});if(state.history.length>90)state.history.shift();
      state.signals=computeSignals(state.history,observation);
      state.vote=consensus(state.signals);state.last=observation;return state.vote;
    },
    target(state){
      const score=state.vote?.score??0;
      return {exposure:score,confidence:Math.abs(score),as_of:state.last?.receivedAt??Date.now(),
        leader:state.vote?.leader?.name??CONSENSUS_SIX_MANIFEST.name,
        rationale:"mean normalized conviction across six transparent signal agents",
        explanation:{signals:state.signals.map(x=>({id:x.id,name:x.name,role:x.role,raw:x.raw,vote:x.vote,reason:x.reason}))}};
    }
  });
}

export const TSMOM_MANIFEST=validateManifest({
  id:"tsmom-12m",name:"Time-Series Momentum 12M",version:"1.0.0",
  universe:["PF_XBTUSD perpetual futures"],
  sampling:"monthly signal from daily futures history",lookback:"12 monthly futures returns + daily volatility history",
  rebalance:"monthly",output:"target_exposure",
  research:["Moskowitz, Ooi & Pedersen (2012), Time Series Momentum"],
  status:"replay",
  history_contract:{dataset_id:"kraken-pf-xbtusd-1d",kind:"ohlcv",price_type:"perpetual_futures",cadence:"1d",min_observations:365,adapter:"tsmom-12m-v1"},
  data_contract:["excessReturn","exAnteVol"],
  note:"Applies the paper's 12-month own-return sign and 40% / ex-ante-volatility rule to Kraken PF_XBTUSD. The current instrument is an experimental application, not part of the paper's original 58-instrument sample."
});

export function createTimeSeriesMomentum(){
  return createCartridge({
    manifest:TSMOM_MANIFEST,
    createState:()=>({returns:[],last:null,vol:null}),
    observe(state,observation){
      const r=Number(observation?.excessReturn),vol=Number(observation?.exAnteVol);
      if(!Number.isFinite(r))throw new TypeError("TSMOM requires monthly excessReturn");
      if(!Number.isFinite(vol)||vol<=0)throw new TypeError("TSMOM requires positive exAnteVol");
      state.returns.push(r);if(state.returns.length>12)state.returns.shift();
      state.last=observation;state.vol=vol;
    },
    target(state){
      if(state.returns.length<12)return {exposure:0,confidence:0,leader:TSMOM_MANIFEST.name,
        rationale:"warming up: 12 monthly excess returns required",
        explanation:{observations:state.returns.length,required:12}};
      const cumulative=state.returns.reduce((g,r)=>g*(1+r),1)-1;
      const direction=Math.sign(cumulative);
      const requestedLeverage=.40/state.vol;
      const exposure=direction*Math.min(1,requestedLeverage);
      return {exposure,confidence:Math.min(1,Math.abs(cumulative)*4),as_of:state.last?.receivedAt??Date.now(),
        leader:TSMOM_MANIFEST.name,rationale:"12-month own-return sign with inverse-volatility risk scaling",
        explanation:{trailing_12m_excess_return:cumulative,ex_ante_vol:state.vol,
          requested_leverage:requestedLeverage,common_risk_cap_applies:true}};
    }
  });
}

export const RESEARCH_CARTRIDGES=Object.freeze([
  {id:"short-term-residual-reversal",name:"Short-Term Residual Reversal",status:"research",universe:["equities"],sampling:"daily",rebalance:"daily/weekly",output:"portfolio_weights"},
  {id:"pairs-stat-arb",name:"Pairs / Statistical Arbitrage",status:"research",universe:["paired instruments"],sampling:"strategy-specific",rebalance:"event-driven",output:"portfolio_weights"},
  {id:"cross-sectional-momentum",name:"Cross-Sectional Momentum",status:"research",universe:["multi-asset"],sampling:"daily/monthly",rebalance:"monthly",output:"portfolio_weights"},
  {id:"pead",name:"Post-Earnings Announcement Drift",status:"research",universe:["equities+earnings"],sampling:"event+daily",rebalance:"event-driven",output:"portfolio_weights"},
  {id:"risk-parity",name:"Risk Parity",status:"research",universe:["multi-asset"],sampling:"daily",rebalance:"periodic",output:"portfolio_weights"},
  {id:"kelly-universal",name:"Kelly / Universal Portfolio",status:"research",universe:["multi-asset"],sampling:"strategy-specific",rebalance:"periodic",output:"portfolio_weights"}
]);

export const STRATEGY_REGISTRY=Object.freeze({
  "consensus-six":Object.freeze({manifest:CONSENSUS_SIX_MANIFEST,create:createConsensusSix}),
  "tsmom-12m":Object.freeze({manifest:TSMOM_MANIFEST,create:createTimeSeriesMomentum}),
  ...Object.fromEntries(RESEARCH_CARTRIDGES.map(x=>[x.id,Object.freeze({manifest:Object.freeze(x),create:null})]))
});

export function createStrategy(id="consensus-six"){
  const entry=STRATEGY_REGISTRY[id];if(!entry)throw new Error("unknown strategy cartridge: "+id);
  if(!entry.create)throw new Error("strategy cartridge is research-only: "+id);
  return entry.create();
}
