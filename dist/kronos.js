import {createCartridge,validateManifest} from "./cartridge.js";

const MODEL="NeoQuasar/Kronos-small";
const MODEL_REV="901c26c1332695a2a8f243eb2f37243a37bea320";
const TOKENIZER_REV="0e0117387f39004a9016484a186a908917e22426";
const DATASET="btc-usd-spot-1d";
const DAY_MS=86_400_000;
const isoMs=value=>{
  if(typeof value!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))throw new TypeError("receipt requires UTC ISO timestamp");
  const ms=Date.parse(value);
  if(!Number.isFinite(ms))throw new TypeError("invalid receipt timestamp");
  return ms;
};
const finitePositive=value=>typeof value==="number"&&Number.isFinite(value)&&value>0;

export const KRONOS_SHADOW_MANIFEST=validateManifest({
  id:"kronos-small-shadow",name:"Kronos Small · Shadow",version:"0.1.0",
  universe:["BTC-USD"],sampling:"daily spot OHLCV",lookback:"2–512 completed daily candles",
  rebalance:"daily replay only",output:"target_exposure",status:"research",
  research:["Kronos pretrained checkpoint; no verified trading edge"],
  note:"External, verified-shape forecast receipts required. Never available for live execution; missing forecasts remain flat.",
  history_contract:{dataset_id:DATASET,kind:"ohlcv",price_type:"spot",cadence:"1d",min_observations:2,adapter:"daily-ohlcv-v1"}
});

export function validateKronosReceipt(receipt){
  if(!receipt||typeof receipt!=="object"||Array.isArray(receipt))throw new TypeError("forecast receipt object required");
  if(receipt.schema_version!==1||receipt.source!=="kronos-inference"||receipt.dataset_id!==DATASET||receipt.model_id!==MODEL)throw new TypeError("unsupported Kronos receipt provenance");
  if(receipt.model_revision!==MODEL_REV||receipt.tokenizer_revision!==TOKENIZER_REV||!/^[0-9a-f]{64}$/.test(receipt.input_digest??""))throw new TypeError("receipt requires pinned model and input digest");
  if(receipt.execution_allowed!==false||receipt.validation_status!=="UNVERIFIED_CHECKPOINT_HISTORY")throw new TypeError("receipt must explicitly prohibit execution and flag unknown checkpoint provenance");
  const at=isoMs(receipt.as_of),next=isoMs(receipt.forecast_for),generated=isoMs(receipt.generated_at);
  if(isoMs(receipt.input_last_at)!==at||next-at!==DAY_MS||generated<at)throw new RangeError("receipt time bounds invalid");
  if(!Number.isInteger(receipt.input_count)||receipt.input_count<2||receipt.input_count>512)throw new RangeError("invalid input length");
  if(!finitePositive(receipt.input_close))throw new RangeError("invalid last observed price");
  if(!Array.isArray(receipt.scenario_closes)||receipt.scenario_closes.length<2||receipt.scenario_closes.length>32||!receipt.scenario_closes.every(finitePositive))throw new RangeError("invalid forecast scenarios");
  if(!Number.isInteger(receipt.seed)||receipt.seed<0||receipt.seed>2_147_483_647)throw new RangeError("invalid seed");
  if(!finitePositive(receipt.temperature)||!(typeof receipt.top_p==="number"&&receipt.top_p>0&&receipt.top_p<=1))throw new RangeError("invalid sampling settings");
  return Object.freeze({...receipt,scenario_closes:Object.freeze([...receipt.scenario_closes])});
}

// Explicit research-only factory: intentionally NOT available through createStrategy().
// A forecast at a completed bar t affects exposure only from t to t+1.
export function createKronosShadow({receipts=[]}={}){
  const byTime=new Map();
  for(const item of receipts){
    const r=validateKronosReceipt(item);
    const key=Date.parse(r.as_of);
    if(byTime.has(key))throw new TypeError("duplicate Kronos as_of receipt");
    byTime.set(key,r);
  }
  return createCartridge({
    manifest:KRONOS_SHADOW_MANIFEST,
    createState:()=>({last:null,receipt:null,exposure:0,pUp:null,matched:0}),
    observe(state,bar){
      const at=Number(bar?.receivedAt),close=Number(bar?.close);
      if(!Number.isFinite(at)||!finitePositive(close))throw new TypeError("Kronos shadow requires stamped positive close");
      if(state.last!==null&&at<=state.last)throw new RangeError("Kronos shadow requires strictly ordered bars");
      state.last=at;state.receipt=null;state.exposure=0;state.pUp=null;
      const r=byTime.get(at);
      if(!r)return;
      if(Math.abs(r.input_close-close)>1e-8*Math.max(1,close))throw new RangeError("forecast receipt does not match replay close");
      state.receipt=r;state.matched++;
      state.pUp=r.scenario_closes.filter(x=>x>close).length/r.scenario_closes.length;
      // Deliberately low exposure for comparative PAPER REPLAY only. Not calibrated confidence.
      state.exposure=state.pUp>=.65?.25:state.pUp<=.35?-.25:0;
    },
    target:state=>({
      exposure:state.exposure,confidence:0,as_of:state.last??0,
      leader:KRONOS_SHADOW_MANIFEST.name,
      rationale:state.receipt?"uncalibrated Kronos scenario vote; REPLAY ONLY":"no matching forecast receipt; flat",
      explanation:{paper_only:true,verified_profitability:false,uncalibrated:true,matched_receipts:state.matched,
        p_up:state.pUp,forecast_for:state.receipt?.forecast_for??null,input_digest:state.receipt?.input_digest??null,
        model_revision:state.receipt?.model_revision??null}
    })
  });
}
