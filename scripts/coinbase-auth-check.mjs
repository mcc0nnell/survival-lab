import {coinbaseConfigured,probeCoinbase} from "../functions/coinbase.js";

if(!coinbaseConfigured()){
  console.error("Coinbase credentials are not configured.");
  process.exit(2);
}

try{
  const result=await probeCoinbase();
  console.log(JSON.stringify({
    ok:result.ok,
    account_count:result.account_count,
    active_count:result.active_count,
    ready_count:result.ready_count,
    currencies:result.currencies
  },null,2));
}catch(error){
  console.error(JSON.stringify({
    ok:false,
    message:error?.message||String(error),
    status:error?.status||null,
    detail:error?.detail||null
  },null,2));
  process.exit(1);
}
