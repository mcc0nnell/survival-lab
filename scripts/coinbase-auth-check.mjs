import fs from "node:fs";
import {coinbaseConfigured,inspectCoinbaseTrading} from "../functions/coinbase.js";

const file=process.env.COINBASE_CREDENTIAL_FILE;
if(file&&(!process.env.COINBASE_API_KEY||!process.env.COINBASE_API_SECRET)){
  const credential=JSON.parse(fs.readFileSync(file,"utf8"));
  process.env.COINBASE_API_KEY=credential.name;
  process.env.COINBASE_API_SECRET=credential.privateKey;
}

if(!coinbaseConfigured()){
  console.error("Coinbase credentials are not configured.");
  process.exit(2);
}

const cap=Number(process.env.COINBASE_BANKROLL_CAP_USD||"10");
const reserve=Number(process.env.COINBASE_RESERVE_USD||"1");
const minimum=Number(process.env.COINBASE_MIN_CANARY_USD||"1");

try{
  const result=await inspectCoinbaseTrading({bankrollCapUsd:cap,reserveUsd:reserve,minimumCanaryUsd:minimum,preview:true});
  console.log(JSON.stringify(result,null,2));
}catch(error){
  console.error(JSON.stringify({
    ok:false,
    message:error?.message||String(error),
    status:error?.status||null,
    detail:error?.detail||null
  },null,2));
  process.exit(1);
}
