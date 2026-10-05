import crypto from "node:crypto";

const COINBASE_HOST="api.coinbase.com";
const COINBASE_ORIGIN="https://"+COINBASE_HOST;
const ED25519_PKCS8_PREFIX=Buffer.from("302e020100300506032b657004220420","hex");

function compactBase64(value){
  return String(value||"").replace(/\s+/g,"");
}

function b64url(value){
  return Buffer.from(value).toString("base64url");
}

function decodeRawEd25519(secret){
  const raw=Buffer.from(compactBase64(secret),"base64");
  if(raw.length!==32&&raw.length!==64){
    throw new Error("Coinbase Ed25519 secret must decode to 32 or 64 bytes");
  }
  return raw.subarray(0,32);
}

export function coinbaseConfigured(env=process.env){
  return Boolean(env.COINBASE_API_KEY&&env.COINBASE_API_SECRET);
}

export function loadCoinbasePrivateKey(secret){
  const value=String(secret||"").trim();
  if(!value)throw new Error("Coinbase API secret missing");
  if(value.startsWith("-----BEGIN")){
    const key=crypto.createPrivateKey(value);
    if(key.asymmetricKeyType!=="ec"&&key.asymmetricKeyType!=="ed25519"){
      throw new Error("Coinbase API key must be ECDSA P-256 or Ed25519");
    }
    return key;
  }
  const seed=decodeRawEd25519(value);
  return crypto.createPrivateKey({
    key:Buffer.concat([ED25519_PKCS8_PREFIX,seed]),
    format:"der",
    type:"pkcs8"
  });
}

export function buildCoinbaseJwt({method,path,apiKey=process.env.COINBASE_API_KEY,apiSecret=process.env.COINBASE_API_SECRET,now=Math.floor(Date.now()/1000),nonce=crypto.randomBytes(16).toString("hex")}){
  if(!apiKey||!apiSecret)throw new Error("Coinbase API credentials are not configured");
  const verb=String(method||"GET").toUpperCase();
  if(!String(path||"").startsWith("/"))throw new Error("Coinbase JWT path must start with /");
  const privateKey=loadCoinbasePrivateKey(apiSecret);
  const type=privateKey.asymmetricKeyType;
  const alg=type==="ed25519"?"EdDSA":"ES256";
  const header={alg,kid:apiKey,nonce,typ:"JWT"};
  const payload={sub:apiKey,iss:"cdp",nbf:now,exp:now+120,uri:verb+" "+COINBASE_HOST+path};
  const input=b64url(JSON.stringify(header))+"."+b64url(JSON.stringify(payload));
  const signature=alg==="EdDSA"
    ?crypto.sign(null,Buffer.from(input),privateKey)
    :crypto.sign("sha256",Buffer.from(input),{key:privateKey,dsaEncoding:"ieee-p1363"});
  return input+"."+signature.toString("base64url");
}

export async function coinbaseRequest(path,{method="GET",body=null,signal}={}){
  const jwt=buildCoinbaseJwt({method,path});
  const headers={authorization:"Bearer "+jwt,accept:"application/json"};
  let encoded;
  if(body!=null){
    headers["content-type"]="application/json";
    encoded=JSON.stringify(body);
  }
  const response=await fetch(COINBASE_ORIGIN+path,{method,headers,body:encoded,signal});
  let data=null;
  const text=await response.text();
  if(text){
    try{data=JSON.parse(text)}catch{data={raw:text.slice(0,500)}}
  }
  if(!response.ok){
    const error=new Error("Coinbase API HTTP "+response.status);
    error.status=response.status;
    error.detail=data;
    throw error;
  }
  return data;
}

export async function probeCoinbase(){
  const data=await coinbaseRequest("/api/v3/brokerage/accounts");
  const accounts=Array.isArray(data?.accounts)?data.accounts:[];
  return {
    ok:true,
    account_count:accounts.length,
    active_count:accounts.filter(a=>a?.active).length,
    ready_count:accounts.filter(a=>a?.ready).length,
    currencies:[...new Set(accounts.filter(a=>a?.active&&a?.ready).map(a=>a.currency).filter(Boolean))].sort()
  };
}
function finite(value,fallback=0){
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
}

function decimals(step){
  const s=String(step||"");
  if(s.includes("e-"))return Number(s.split("e-")[1])||0;
  const dot=s.indexOf(".");
  return dot<0?0:s.length-dot-1;
}

function ceilToIncrement(value,increment){
  const inc=finite(increment,0);
  if(!(inc>0))return value;
  return Math.ceil((value-1e-12)/inc)*inc;
}

function formatIncrement(value,increment){
  return Number(value).toFixed(Math.min(12,decimals(increment)));
}

export function computeCoinbaseCanary({
  usdAvailable,bankrollCapUsd=10,reserveUsd=1,quoteMinSize=0,quoteIncrement=.01,minimumCanaryUsd=1
}={}){
  const available=Math.max(0,finite(usdAvailable));
  const cap=Math.max(0,Math.min(available,finite(bankrollCapUsd,10)));
  const reserve=Math.max(0,finite(reserveUsd,1));
  const minQuote=Math.max(0,finite(quoteMinSize));
  const increment=Math.max(0,finite(quoteIncrement,.01));
  const desired=Math.max(minQuote,finite(minimumCanaryUsd,1));
  const quote=ceilToIncrement(desired,increment);
  const headroom=Math.max(0,cap-reserve);
  const ready=quote>0&&quote<=headroom;
  return {
    usd_available:available,
    bankroll_cap_usd:cap,
    reserve_usd:reserve,
    quote_min_size:minQuote,
    quote_increment:increment,
    canary_quote_size:ready?quote:null,
    canary_quote_size_text:ready?formatIncrement(quote,increment):null,
    headroom_usd:headroom,
    ready,
    reason:ready?"candidate fits bankroll and reserve":headroom<=0?"no bankroll headroom":"minimum valid canary exceeds headroom"
  };
}

export async function inspectCoinbaseTrading({productId="BTC-USD",bankrollCapUsd=10,reserveUsd=1,minimumCanaryUsd=1,preview=true}={}){
  const [accountData,product,fees]=await Promise.all([
    coinbaseRequest("/api/v3/brokerage/accounts"),
    coinbaseRequest("/api/v3/brokerage/products/"+encodeURIComponent(productId)),
    coinbaseRequest("/api/v3/brokerage/transaction_summary")
  ]);
  const accounts=Array.isArray(accountData?.accounts)?accountData.accounts:[];
  const usdAccounts=accounts.filter(a=>a?.active&&a?.ready&&a?.currency==="USD");
  const usdAvailable=usdAccounts.reduce((sum,a)=>sum+Math.max(0,finite(a?.available_balance?.value)),0);
  const policy=computeCoinbaseCanary({
    usdAvailable,bankrollCapUsd,reserveUsd,minimumCanaryUsd,
    quoteMinSize:product?.quote_min_size,quoteIncrement:product?.quote_increment
  });
  const productReady=Boolean(product&&!product.is_disabled&&!product.trading_disabled&&!product.cancel_only&&!product.view_only);
  let orderPreview=null;
  if(preview&&policy.ready&&productReady){
    const raw=await coinbaseRequest("/api/v3/brokerage/orders/preview",{
      method:"POST",
      body:{product_id:productId,side:"BUY",order_configuration:{market_market_ioc:{quote_size:policy.canary_quote_size_text}}}
    });
    const errs=Array.isArray(raw?.errs)?raw.errs.filter(Boolean):[];
    const commission=finite(raw?.commission_total,0);
    const orderTotal=finite(raw?.order_total,0);
    const projectedDebit=Math.max(policy.canary_quote_size+commission,orderTotal);
    const capAfterReserve=Math.max(0,policy.bankroll_cap_usd-policy.reserve_usd);
    orderPreview={
      ok:errs.length===0&&projectedDebit<=capAfterReserve+1e-9,
      errs,
      warnings:Array.isArray(raw?.warning)?raw.warning.filter(Boolean):[],
      quote_size:finite(raw?.quote_size,policy.canary_quote_size),
      base_size:finite(raw?.base_size,0),
      commission_total:commission,
      order_total:orderTotal,
      estimated_fill_price:raw?.est_average_filled_price||null,
      slippage:raw?.slippage||null,
      projected_debit:projectedDebit,
      available_buying_power:raw?.available_buying_power||null
    };
  }
  const feeTier=fees?.fee_tier||{};
  const ready=Boolean(policy.ready&&productReady&&(!preview||orderPreview?.ok));
  return {
    ok:true,
    product_id:productId,
    execution:"preview-only",
    usd_available:usdAvailable,
    bankroll:policy,
    product:{
      quote_min_size:product?.quote_min_size??null,
      quote_increment:product?.quote_increment??null,
      base_min_size:product?.base_min_size??null,
      base_increment:product?.base_increment??null,
      price:product?.price??null,
      status:product?.status??null,
      trading_disabled:Boolean(product?.trading_disabled),
      cancel_only:Boolean(product?.cancel_only),
      limit_only:Boolean(product?.limit_only),
      post_only:Boolean(product?.post_only),
      view_only:Boolean(product?.view_only)
    },
    fees:{
      pricing_tier:feeTier?.pricing_tier??null,
      taker_fee_rate:feeTier?.taker_fee_rate??null,
      maker_fee_rate:feeTier?.maker_fee_rate??null
    },
    preview:orderPreview,
    ready_for_canary:ready,
    blocker:ready?null:!productReady?"product is not currently tradeable":!policy.ready?policy.reason:"order preview rejected or exceeds reserve"
  };
}
