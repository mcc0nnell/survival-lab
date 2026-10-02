import {AGENTS,computeSignals,consensus} from "./core.js";
import {createCartridge,validateManifest} from "./cartridge.js";

const SPOT_DAILY_HISTORY=Object.freeze({dataset_id:"btc-usd-spot-1d",kind:"ohlcv",price_type:"spot",cadence:"1d",adapter:"daily-ohlcv-v1"});
const mean=values=>values.reduce((sum,x)=>sum+x,0)/Math.max(1,values.length);

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

export const BUY_HOLD_MANIFEST=validateManifest({
  id:"btc-buy-hold",name:"BTC Buy & Hold",version:"1.0.0",universe:["BTC-USD"],
  sampling:"daily spot close",lookback:"1 daily close",rebalance:"initial allocation only",output:"target_exposure",
  research:["benchmark"],status:"replay",history_contract:{...SPOT_DAILY_HISTORY,min_observations:1},
  note:"Control cartridge: constant +1 exposure after the first valid BTC-USD daily close."
});

export function createBuyHold(){
  return createCartridge({
    manifest:BUY_HOLD_MANIFEST,
    createState:()=>({last:null,seen:false}),
    observe(state,observation){
      const close=Number(observation?.close);if(!Number.isFinite(close)||close<=0)throw new TypeError("Buy & Hold requires positive close");
      state.seen=true;state.last=observation;
    },
    target:state=>({exposure:state.seen?1:0,confidence:state.seen?1:0,as_of:state.last?.receivedAt??Date.now(),leader:BUY_HOLD_MANIFEST.name,
      rationale:state.seen?"constant long benchmark":"warming up: one daily close required",explanation:{benchmark:true}})
  });
}

export const SMA_CROSS_MANIFEST=validateManifest({
  id:"sma-50-200",name:"SMA 50 / 200 Trend",version:"1.0.0",universe:["BTC-USD"],
  sampling:"daily spot close",lookback:"200 daily closes",rebalance:"daily",output:"target_exposure",
  research:["dual moving-average trend following"],status:"replay",history_contract:{...SPOT_DAILY_HISTORY,min_observations:200},
  note:"Transparent dual-moving-average trend cartridge; +1 when SMA-50 is above SMA-200, -1 when it is below."
});

export function createSmaCross(){
  return createCartridge({
    manifest:SMA_CROSS_MANIFEST,
    createState:()=>({closes:[],last:null}),
    observe(state,observation){
      const close=Number(observation?.close);if(!Number.isFinite(close)||close<=0)throw new TypeError("SMA 50/200 requires positive close");
      state.closes.push(close);if(state.closes.length>200)state.closes.shift();state.last=observation;
    },
    target(state){
      if(state.closes.length<200)return {exposure:0,confidence:0,leader:SMA_CROSS_MANIFEST.name,rationale:"warming up: 200 daily closes required",explanation:{observations:state.closes.length,required:200}};
      const fast=mean(state.closes.slice(-50)),slow=mean(state.closes),spread=slow?fast/slow-1:0,exposure=Math.sign(spread);
      return {exposure,confidence:Math.min(1,Math.abs(spread)*25),as_of:state.last?.receivedAt??Date.now(),leader:SMA_CROSS_MANIFEST.name,
        rationale:"sign of 50-day versus 200-day simple moving-average spread",explanation:{sma_50:fast,sma_200:slow,spread_pct:spread*100}};
    }
  });
}

export const DONCHIAN_MANIFEST=validateManifest({
  id:"donchian-55-20",name:"Donchian 55 / 20 Breakout",version:"1.0.0",universe:["BTC-USD"],
  sampling:"daily spot OHLC",lookback:"55 daily bars",rebalance:"daily on channel breaks",output:"target_exposure",
  research:["Donchian/Turtle-style breakout"],status:"replay",history_contract:{...SPOT_DAILY_HISTORY,min_observations:56},
  note:"Uses prior bars only: 55-day breakout entries and 20-day opposite-channel exits."
});

export function createDonchian(){
  return createCartridge({
    manifest:DONCHIAN_MANIFEST,
    createState:()=>({bars:[],position:0,last:null,lastSignal:"warming up"}),
    observe(state,observation){
      const high=Number(observation?.high),low=Number(observation?.low),close=Number(observation?.close);
      if(![high,low,close].every(Number.isFinite)||high<=0||low<=0||close<=0||high<low)throw new TypeError("Donchian requires valid OHLC");
      const prior55=state.bars.slice(-55),prior20=state.bars.slice(-20);
      if(prior55.length>=55){
        const entryHigh=Math.max(...prior55.map(x=>x.high)),entryLow=Math.min(...prior55.map(x=>x.low));
        const exitHigh=Math.max(...prior20.map(x=>x.high)),exitLow=Math.min(...prior20.map(x=>x.low));
        if(state.position===0&&high>entryHigh){state.position=1;state.lastSignal="55-day upside breakout"}
        else if(state.position===0&&low<entryLow){state.position=-1;state.lastSignal="55-day downside breakout"}
        else if(state.position>0&&low<exitLow){state.position=0;state.lastSignal="20-day long exit"}
        else if(state.position<0&&high>exitHigh){state.position=0;state.lastSignal="20-day short exit"}
      }
      state.bars.push({high,low,close});if(state.bars.length>55)state.bars.shift();state.last=observation;
    },
    target:state=>({exposure:state.position,confidence:state.position?1:0,as_of:state.last?.receivedAt??Date.now(),leader:DONCHIAN_MANIFEST.name,
      rationale:state.lastSignal,explanation:{position:state.position,bars:state.bars.length,entry_lookback:55,exit_lookback:20}})
  });
}

export const RSI_MANIFEST=validateManifest({
  id:"rsi-14-reversion",name:"RSI-14 Mean Reversion",version:"1.0.0",universe:["BTC-USD"],
  sampling:"daily spot close",lookback:"15 daily closes",rebalance:"daily on RSI thresholds",output:"target_exposure",
  research:["RSI threshold mean reversion"],status:"replay",history_contract:{...SPOT_DAILY_HISTORY,min_observations:15},
  note:"Contrarian threshold cartridge: long below RSI 30, short above RSI 70, flat after crossing the 50 midline."
});

export function createRsiReversion(){
  return createCartridge({
    manifest:RSI_MANIFEST,
    createState:()=>({previous:null,seedGains:[],seedLosses:[],avgGain:null,avgLoss:null,position:0,last:null,rsi:null,count:0,lastSignal:"warming up"}),
    observe(state,observation){
      const close=Number(observation?.close);if(!Number.isFinite(close)||close<=0)throw new TypeError("RSI-14 requires positive close");
      state.last=observation;state.count++;
      if(state.previous==null){state.previous=close;return}
      const change=close-state.previous,gain=Math.max(change,0),loss=Math.max(-change,0);state.previous=close;
      if(state.avgGain==null){
        state.seedGains.push(gain);state.seedLosses.push(loss);
        if(state.seedGains.length<14)return;
        state.avgGain=mean(state.seedGains);state.avgLoss=mean(state.seedLosses);
      }else{
        state.avgGain=(state.avgGain*13+gain)/14;state.avgLoss=(state.avgLoss*13+loss)/14;
      }
      state.rsi=state.avgLoss===0?100:state.avgGain===0?0:100-(100/(1+state.avgGain/state.avgLoss));
      if(state.position===0&&state.rsi<30){state.position=1;state.lastSignal="RSI below 30"}
      else if(state.position===0&&state.rsi>70){state.position=-1;state.lastSignal="RSI above 70"}
      else if(state.position>0&&state.rsi>=50){state.position=0;state.lastSignal="RSI long exit at midline"}
      else if(state.position<0&&state.rsi<=50){state.position=0;state.lastSignal="RSI short exit at midline"}
    },
    target:state=>({exposure:state.position,confidence:Number.isFinite(state.rsi)?Math.min(1,Math.abs(state.rsi-50)/50):0,as_of:state.last?.receivedAt??Date.now(),leader:RSI_MANIFEST.name,
      rationale:state.lastSignal,explanation:{rsi_14:state.rsi,position:state.position,observations:state.count,method:"Wilder smoothing"}})
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
  "btc-buy-hold":Object.freeze({manifest:BUY_HOLD_MANIFEST,create:createBuyHold}),
  "sma-50-200":Object.freeze({manifest:SMA_CROSS_MANIFEST,create:createSmaCross}),
  "donchian-55-20":Object.freeze({manifest:DONCHIAN_MANIFEST,create:createDonchian}),
  "rsi-14-reversion":Object.freeze({manifest:RSI_MANIFEST,create:createRsiReversion}),
  ...Object.fromEntries(RESEARCH_CARTRIDGES.map(x=>[x.id,Object.freeze({manifest:Object.freeze(x),create:null})]))
});

export function createStrategy(id="consensus-six"){
  const entry=STRATEGY_REGISTRY[id];if(!entry)throw new Error("unknown strategy cartridge: "+id);
  if(!entry.create)throw new Error("strategy cartridge is research-only: "+id);
  return entry.create();
}
