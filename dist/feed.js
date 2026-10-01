const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url,timeoutMs=3500){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{cache:"no-store",headers:{"Accept":"application/json"},signal:controller.signal});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

export class CoinbaseFeed{
  constructor(product="BTC-USD"){this.product=product;this.name="COINBASE";this.lastTradeId=null;}
  async next(){
    const base="https://api.exchange.coinbase.com/products/"+encodeURIComponent(this.product);
    const [book,trades]=await Promise.all([getJson(base+"/book?level=1"),getJson(base+"/trades?limit=1")]);
    const t=trades[0], bid=Number(book.bids?.[0]?.[0]), ask=Number(book.asks?.[0]?.[0]);
    const bidSize=Number(book.bids?.[0]?.[1]||0), askSize=Number(book.asks?.[0]?.[1]||0);
    const last=Number(t?.price ?? (bid+ask)/2);
    if(!Number.isFinite(bid)||!Number.isFinite(ask)||!Number.isFinite(last)) throw new Error("malformed market data");
    const aggressor=t?.side==="sell"?1:t?.side==="buy"?-1:0;
    this.lastTradeId=t?.trade_id ?? this.lastTradeId;
    return {source:this.name,product:this.product,bid,ask,bidSize,askSize,last,aggressor,
      tradeId:this.lastTradeId,sequence:book.sequence,exchangeTime:t?.time||book.time||null,receivedAt:Date.now()};
  }
}

function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

export class SyntheticFeed{
  constructor(seed=0xA11CE,start=62400){
    this.name="SYNTHETIC";this.rng=mulberry(seed);this.price=start;this.tick=0;this.pendingShock=0;
  }
  shock(){
    this.pendingShock=(this.rng()>.5?1:-1)*(.018+this.rng()*.018);
    return this.pendingShock;
  }
  async next(){
    this.tick++;
    const wave=Math.sin(this.tick/10)*.0009;
    const noise=(this.rng()-.5)*.0054;
    const ret=wave+noise+this.pendingShock;this.pendingShock=0;
    this.price*=1+ret;
    const spreadBps=1.5+this.rng()*2.5, half=this.price*spreadBps/20000;
    const bid=this.price-half,ask=this.price+half;
    const bidSize=.01+this.rng()*.08,askSize=.01+this.rng()*.08;
    return {source:this.name,product:"BTC-USD",bid,ask,bidSize,askSize,last:this.price,
      aggressor:this.rng()>.5?1:-1,tradeId:"s-"+this.tick,sequence:this.tick,
      exchangeTime:null,receivedAt:Date.now()};
  }
}

export class ReplayFeed{
  constructor(tape=[]){this.name="REPLAY";this.tape=tape;this.i=0;}
  async next(){
    if(!this.tape.length) throw new Error("empty replay tape");
    const q={...this.tape[this.i%this.tape.length],source:"REPLAY",receivedAt:Date.now()};
    this.i++;await sleep(0);return q;
  }
}
