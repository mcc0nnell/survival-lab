const requiredManifestFields=["id","name","version","universe","sampling","rebalance","output"];

export function validateManifest(manifest){
  if(!manifest||typeof manifest!=="object")throw new TypeError("strategy manifest required");
  for(const key of requiredManifestFields){
    if(manifest[key]==null||manifest[key]==="")throw new TypeError("strategy manifest missing "+key);
  }
  if(!Array.isArray(manifest.universe)||!manifest.universe.length)throw new TypeError("strategy universe must be non-empty");
  if(!["target_exposure","portfolio_weights"].includes(manifest.output))throw new TypeError("unsupported strategy output");
  return Object.freeze({...manifest,universe:Object.freeze([...manifest.universe])});
}

export function normalizeTarget(target,manifest){
  if(!target||typeof target!=="object")throw new TypeError("strategy target required");
  const exposure=Number(target.exposure);
  if(manifest.output==="target_exposure"&&(!Number.isFinite(exposure)||exposure < -1||exposure > 1)){
    throw new RangeError("target exposure must be within [-1, 1]");
  }
  const confidence=Number(target.confidence??Math.abs(exposure));
  return Object.freeze({
    strategy_id:manifest.id,
    exposure,
    score:exposure,
    confidence:Number.isFinite(confidence)?Math.max(0,Math.min(1,confidence)):0,
    as_of:target.as_of??Date.now(),
    leader:target.leader??manifest.name,
    rationale:target.rationale??"",
    explanation:target.explanation??null
  });
}

export function createCartridge({manifest,createState,observe,target,reset}){
  const checked=validateManifest(manifest);
  if(typeof observe!=="function"||typeof target!=="function")throw new TypeError("cartridge requires observe() and target()");
  let state=createState?createState():{};
  return Object.freeze({
    manifest:checked,
    observe(observation){return observe(state,observation)},
    target(){return normalizeTarget(target(state),checked)},
    explain(){return this.target().explanation},
    reset(){state=reset?reset(state):(createState?createState():{});return this}
  });
}
