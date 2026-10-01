const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function parseCoinbaseTicker(message,receivedAt=Date.now()){
  if(!message||message.type!=="ticker") return null;
  const bid=Number(message.best_bid), ask=Number(message.best_ask), last=Number(message.price);
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||!Number.isFinite(last)||bid<=0||ask<bid) return null;
  const side=message.side;
  return {
    source:"COINBASE_WS",
    product:message.product_id||"BTC-USD",
    bid, ask, last,
    bidSize:Number(message.best_bid_size||0),
    askSize:Number(message.best_ask_size||0),
    aggressor:side==="sell"?1:side==="buy"?-1:0,
    tradeId:message.trade_id ?? null,
    sequence:message.sequence ?? null,
    exchangeTime:message.time||null,
    receivedAt
  };
}

export class CoinbaseFeed{
  constructor(product="BTC-USD"){
    this.product=product;this.name="COINBASE_WS";this.quote=null;this.status="IDLE";
    this.ws=null;this.closed=false;this.reconnectTimer=null;this.reconnectAttempt=0;
    this.quoteListeners=new Set();this.statusListeners=new Set();
  }
  start(onQuote,onStatus){
    if(onQuote)this.quoteListeners.add(onQuote);
    if(onStatus)this.statusListeners.add(onStatus);
    this.closed=false;
    if(!this.ws)this.connect();
    return this;
  }
  setStatus(status,detail=null){
    if(this.status===status&&!detail)return;
    this.status=status;
    for(const fn of this.statusListeners){try{fn(status,detail)}catch{}}
  }
  connect(){
    if(this.closed)return;
    clearTimeout(this.reconnectTimer);
    this.setStatus("CONNECTING");
    const ws=new WebSocket("wss://ws-feed.exchange.coinbase.com");
    this.ws=ws;
    ws.onopen=()=>{
      this.reconnectAttempt=0;this.setStatus("CONNECTED");
      ws.send(JSON.stringify({type:"subscribe",product_ids:[this.product],channels:["ticker"]}));
    };
    ws.onmessage=event=>{
      let message;
      try{message=JSON.parse(event.data)}catch{return}
      if(message.type==="error"){
        this.setStatus("ERROR",message.message||"Coinbase feed error");return;
      }
      const quote=parseCoinbaseTicker(message,Date.now());
      if(!quote)return;
      this.quote=quote;this.setStatus("LIVE");
      for(const fn of this.quoteListeners){try{fn({...quote})}catch{}}
    };
    ws.onerror=()=>this.setStatus("ERROR","WebSocket transport error");
    ws.onclose=()=>{
      if(this.ws===ws)this.ws=null;
      if(this.closed){this.setStatus("CLOSED");return}
      this.setStatus("RECONNECTING");
      const delay=Math.min(10000,500*2**Math.min(this.reconnectAttempt++,5));
      this.reconnectTimer=setTimeout(()=>this.connect(),delay);
    };
  }
  latest(){return this.quote?{...this.quote}:null}
  async next(timeoutMs=5000){
    const existing=this.latest();
    if(existing)return existing;
    return await new Promise((resolve,reject)=>{
      let timer;
      const done=q=>{clearTimeout(timer);this.quoteListeners.delete(done);resolve({...q})};
      this.quoteListeners.add(done);
      timer=setTimeout(()=>{this.quoteListeners.delete(done);reject(new Error("live quote timeout"))},timeoutMs);
      if(!this.ws)this.start();
    });
  }
  close(){
    this.closed=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=null;
    const ws=this.ws;this.ws=null;
    if(ws&&ws.readyState<2){try{ws.close(1000,"client reset")}catch{}}
    this.setStatus("CLOSED");
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
    const spreadBps=1.5+this.rng()*2.5,half=this.price*spreadBps/20000;
    const bid=this.price-half,ask=this.price+half;
    const bidSize=.01+this.rng()*.08,askSize=.01+this.rng()*.08;
    return {source:this.name,product:"BTC-USD",bid,ask,bidSize,askSize,last:this.price,
      aggressor:this.rng()>.5?1:-1,tradeId:"s-"+this.tick,sequence:this.tick,
      exchangeTime:null,receivedAt:Date.now()};
  }
  close(){}
}

export class ReplayFeed{
  constructor(tape=[]){this.name="REPLAY";this.tape=tape;this.i=0;}
  async next(){
    if(!this.tape.length)throw new Error("empty replay tape");
    const q={...this.tape[this.i%this.tape.length],source:"REPLAY",receivedAt:Date.now()};
    this.i++;await sleep(0);return q;
  }
  close(){}
}
