import test from "node:test";
import assert from "node:assert/strict";
import {computeCoinbaseCanary} from "../functions/coinbase.js";

test("canary keeps a cash reserve and rounds up to quote increment",()=>{
  const r=computeCoinbaseCanary({usdAvailable:9.75,bankrollCapUsd:9.75,reserveUsd:1,quoteMinSize:.5,quoteIncrement:.01,minimumCanaryUsd:1});
  assert.equal(r.ready,true);
  assert.equal(r.canary_quote_size,1);
  assert.equal(r.canary_quote_size_text,"1.00");
  assert.equal(r.headroom_usd,8.75);
});

test("canary fails closed when exchange minimum would breach reserve",()=>{
  const r=computeCoinbaseCanary({usdAvailable:9.75,bankrollCapUsd:9.75,reserveUsd:1,quoteMinSize:9,quoteIncrement:.01,minimumCanaryUsd:1});
  assert.equal(r.ready,false);
  assert.equal(r.canary_quote_size,null);
});

test("canary never treats more than configured bankroll cap as spendable",()=>{
  const r=computeCoinbaseCanary({usdAvailable:100,bankrollCapUsd:9.75,reserveUsd:1,quoteMinSize:1,quoteIncrement:.01,minimumCanaryUsd:1});
  assert.equal(r.bankroll_cap_usd,9.75);
  assert.equal(r.headroom_usd,8.75);
});
