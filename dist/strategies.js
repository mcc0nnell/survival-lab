import {AGENTS,computeSignals,consensus} from "./core.js";
import {createCartridge,validateManifest} from "./cartridge.js";

export const CONSENSUS_SIX_MANIFEST=validateManifest({
  id:"consensus-six",
  name:"Consensus Six",
  version:"1.0.0",
  universe:["BTC-USD"],
  sampling:"1s",
  lookback:"90 observations",
  rebalance:"event-driven through common risk/execution gate",
  output:"target_exposure",
  research:["transparent rule ensemble"],
  status:"active"
});

export function createConsensusSix(){
  return createCartridge({
    manifest:CONSENSUS_SIX_MANIFEST,
    createState:()=>({history:[],signals:[],vote:{score:0,leader:AGENTS[0]},last:null}),
    observe(state,observation){
      state.history.push({...observation});
      if(state.history.length>90)state.history.shift();
      state.signals=computeSignals(state.history,observation);
      state.vote=consensus(state.signals);
      state.last=observation;
      return state.vote;
    },
    target(state){
      const score=state.vote?.score??0;
      return {
        exposure:score,
        confidence:Math.abs(score),
        as_of:state.last?.receivedAt??Date.now(),
        leader:state.vote?.leader?.name??CONSENSUS_SIX_MANIFEST.name,
        rationale:"mean normalized conviction across six transparent signal agents",
        explanation:{
          signals:state.signals.map(x=>({id:x.id,name:x.name,role:x.role,raw:x.raw,vote:x.vote,reason:x.reason}))
        }
      };
    }
  });
}

export const RESEARCH_CARTRIDGES=Object.freeze([
  {id:"time-series-momentum",name:"Time-Series Momentum",status:"research",universe:["multi-asset"],sampling:"daily",rebalance:"daily/monthly",output:"target_exposure"},
  {id:"short-term-residual-reversal",name:"Short-Term Residual Reversal",status:"research",universe:["equities"],sampling:"daily",rebalance:"daily/weekly",output:"portfolio_weights"},
  {id:"pairs-stat-arb",name:"Pairs / Statistical Arbitrage",status:"research",universe:["paired instruments"],sampling:"strategy-specific",rebalance:"event-driven",output:"portfolio_weights"},
  {id:"cross-sectional-momentum",name:"Cross-Sectional Momentum",status:"research",universe:["multi-asset"],sampling:"daily/monthly",rebalance:"monthly",output:"portfolio_weights"},
  {id:"pead",name:"Post-Earnings Announcement Drift",status:"research",universe:["equities+earnings"],sampling:"event+daily",rebalance:"event-driven",output:"portfolio_weights"},
  {id:"risk-parity",name:"Risk Parity",status:"research",universe:["multi-asset"],sampling:"daily",rebalance:"periodic",output:"portfolio_weights"},
  {id:"kelly-universal",name:"Kelly / Universal Portfolio",status:"research",universe:["multi-asset"],sampling:"strategy-specific",rebalance:"periodic",output:"portfolio_weights"}
]);

export const STRATEGY_REGISTRY=Object.freeze({
  "consensus-six":Object.freeze({manifest:CONSENSUS_SIX_MANIFEST,create:createConsensusSix}),
  ...Object.fromEntries(RESEARCH_CARTRIDGES.map(x=>[x.id,Object.freeze({manifest:Object.freeze(x),create:null})]))
});

export function createStrategy(id="consensus-six"){
  const entry=STRATEGY_REGISTRY[id];
  if(!entry)throw new Error("unknown strategy cartridge: "+id);
  if(!entry.create)throw new Error("strategy cartridge is research-only: "+id);
  return entry.create();
}
