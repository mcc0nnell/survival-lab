import { CoinbaseFeed } from "../dist/feed.js";

const quote=await new CoinbaseFeed("BTC-USD").next();
if(!(quote.bid>0&&quote.ask>=quote.bid&&quote.last>0)){
  throw new Error("invalid live quote");
}
console.log(JSON.stringify({
  ok:true,
  source:quote.source,
  product:quote.product,
  bid:quote.bid,
  ask:quote.ask,
  last:quote.last,
  spreadBps:(quote.ask-quote.bid)/quote.last*10000,
  exchangeTime:quote.exchangeTime
}));
