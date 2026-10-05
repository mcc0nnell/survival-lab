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
