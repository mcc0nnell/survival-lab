import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {buildCoinbaseJwt,coinbaseConfigured,loadCoinbasePrivateKey} from "../functions/coinbase.js";

function decode(part){
  return JSON.parse(Buffer.from(part,"base64url").toString("utf8"));
}

test("Coinbase credential boundary stays disabled without both secrets",()=>{
  assert.equal(coinbaseConfigured({}),false);
  assert.equal(coinbaseConfigured({COINBASE_API_KEY:"k"}),false);
  assert.equal(coinbaseConfigured({COINBASE_API_KEY:"k",COINBASE_API_SECRET:"s"}),true);
});

test("raw 64-byte Ed25519 CDP keys produce a valid REST JWT",()=>{
  const {privateKey}=crypto.generateKeyPairSync("ed25519");
  const jwk=privateKey.export({format:"jwk"});
  const seed=Buffer.from(jwk.d,"base64url");
  const pub=Buffer.from(jwk.x,"base64url");
  const secret=Buffer.concat([seed,pub]).toString("base64");
  const apiKey="organizations/test/apiKeys/test";
  const token=buildCoinbaseJwt({
    method:"GET",path:"/api/v3/brokerage/accounts",
    apiKey,apiSecret:secret,now:1_800_000_000,nonce:"abc"
  });
  const [h,p,s]=token.split(".");
  assert.deepEqual(decode(h),{alg:"EdDSA",kid:apiKey,nonce:"abc",typ:"JWT"});
  assert.deepEqual(decode(p),{
    sub:apiKey,iss:"cdp",nbf:1_800_000_000,exp:1_800_000_120,
    uri:"GET api.coinbase.com/api/v3/brokerage/accounts"
  });
  const key=loadCoinbasePrivateKey(secret);
  const publicKey=crypto.createPublicKey(key);
  assert.equal(crypto.verify(null,Buffer.from(h+"."+p),publicKey,Buffer.from(s,"base64url")),true);
});
