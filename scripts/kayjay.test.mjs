import test from "node:test";
import http from "node:http";
const getStatus=(url,options={})=>new Promise((resolve,reject)=>{const r=http.request(url,options,res=>{res.resume();resolve(res.statusCode);});r.on("error",reject);r.end();});
import assert from "node:assert/strict";
import {allowCommand,redact,createCockpitServer} from "./kayjay.mjs";
test("live and unknown sessions cannot execute through eTape", () => {
  for (const name of ["SubmitOrder","CancelOrder","ReplaceOrder","Flatten","Arm","KillSwitch"])
    assert.equal(allowCommand({kind:"command",name,args:{venue:"sim"}},false), false);
});
test("practice orders require observed demo mode", () => {
  assert.equal(allowCommand({kind:"command",name:"SubmitOrder",args:{venue:"sim"}},true),true);
});
test("session switching and unrecognized mutations fail closed even in demo", () => {
  for (const name of ["ReturnToLive","StartLive","StopDemo","StartReplay","StopReplay","FutureBrokerCommand"])
    assert.equal(allowCommand({kind:"command",name},true),false);
});
test("workspace persistence and market subscriptions remain available", () => {
  assert.equal(allowCommand({kind:"command",name:"GetConfig"},false),true);
  assert.equal(allowCommand({kind:"command",name:"SetConfig",args:{key:"workspace.kayjay"}},false),true);
  assert.equal(allowCommand({kind:"subscribe",topic:"md.bars"},false),true);
});
test("account display subscriptions are allowed without enabling execution", () => {
  assert.equal(allowCommand({kind:"command",name:"SetAccountDemand",args:{panelId:"account",venue:"sim-paper"}},false),true);
});
test("nested credential values are never returned", () => {
  assert.deepEqual(redact({nested:[{api_key:"example",password:"",value:12}]}),{nested:[{api_key:"SET",password:"UNSET",value:12}]});
});
test("HTTP rejects foreign origins and mutation requests", async () => {
  const server=createCockpitServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const base="http://127.0.0.1:"+server.address().port;
    assert.equal((await getStatus(base+"/kayjay/status",{headers:{host:"foreign.example"}})),403);
    assert.equal((await getStatus(base+"/kayjay/status",{headers:{host:"127.0.0.1:8687",origin:"https://foreign.example"}})),403);
    assert.equal((await getStatus(base+"/kayjay/status",{method:"POST",headers:{host:"127.0.0.1:8687"}})),405);
    assert.equal((await getStatus(base+"/.env",{headers:{host:"127.0.0.1:8687"}})),404);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

import {validateMarket,candlesForChart} from "./kayjay-market.mjs";
test("public market route restricts symbols and candle intervals",()=>{
 assert.equal(validateMarket("BTC",60),true);
 assert.equal(validateMarket("../accounts",60),false);
 assert.equal(validateMarket("ETH",1),false);
});
test("Coinbase candles map OHLC correctly, deduplicate and sort",()=>{
 assert.deepEqual(candlesForChart([[2,9,12,10,11,5],[1,8,11,9,10,3],[2,9,12,10,11,5],[3,NaN,1,1,1,1]]),[
 {time:1,low:8,high:11,open:9,close:10,volume:3},{time:2,low:9,high:12,open:10,close:11,volume:5}]);
});

import {portfolioView} from "./kayjay.mjs";
test("portfolio projection masks accounts and never converts missing balances to zero",()=>{
 assert.deepEqual(portfolioView({type:"cash",account_number:"12345678"},{total_value:"0",cash:null,crypto_value:"invalid",token:"do-not-return"}),{account:"cash • 5678",total:0,cash:null,crypto:null,currency:"USD"});
});

import {applyEngineMode} from "./kayjay.mjs";
import {pairView,tokenCandles,discover} from "./kayjay-discovery.mjs";
test("mode control requires explicit confirmation and supported engine",async()=>{
 const unexpected=()=>{throw new Error("Must not contact engine");};
 await assert.rejects(()=>applyEngineMode({engine:"ATLAS",mode:"AUTO"},unexpected));
 await assert.rejects(()=>applyEngineMode({engine:"RAPTOR15",mode:"AUTO",confirm:true},unexpected));
 await assert.rejects(()=>applyEngineMode({engine:"JINX",mode:"OFF",confirm:true},unexpected));
});
test("ATLAS mode request obeys existing authority allowed modes",async()=>{
 const calls=[];const send=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>options.method?{mode:"MANUAL"}:{mode:"OFF",allowed_modes:["OFF","MANUAL"]}};};
 assert.deepEqual(await applyEngineMode({engine:"ATLAS",mode:"MANUAL",confirm:true},send),{mode:"MANUAL"});
 assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1].options.body),{mode:"MANUAL"});
 await assert.rejects(()=>applyEngineMode({engine:"ATLAS",mode:"AUTO",confirm:true},send));
});
test("discovery identifiers cannot escape fixed provider routes",async()=>{
 await assert.rejects(()=>tokenCandles("../accounts","test"));await assert.rejects(()=>discover("x".repeat(101),"search"));
 const p=pairView({chainId:"solana",pairAddress:"pool",baseToken:{symbol:"BONK"},priceUsd:"0.001",volume:{h24:null}});
 assert.equal(p.price,.001);assert.equal(p.volume,null);
});

import {probe} from "./kayjay.mjs";
import {connectionState,sourceData} from "./kayjay-state.mjs";
test("HTTP success with account error is degraded, never a zero balance",async()=>{
 const result=await probe("ATLAS positions","http://unused",false,async()=>({ok:true,json:async()=>({error:"broker failed",positions:[]})}));
 assert.equal(result.state,"DEGRADED");assert.equal(sourceData("ATLAS",result).available,false);assert.equal(result.lastSuccess,null);
});
test("broker readiness requires authenticated proof",()=>{
 assert.equal(connectionState("Webull",{ready:true}).state,"DEGRADED");
 assert.equal(connectionState("OANDA",{ready:true,checks:{authentication:true}}).state,"CONNECTED");
 assert.equal(connectionState("Robinhood",{connected:false}).authenticated,false);
});

import {generateKeyPairSync,verify} from "node:crypto";
import {coinbaseJwt,readCoinbase} from "./kayjay-coinbase.mjs";
test("Coinbase read JWT binds host, path, expiry and verifiable P-256 signature",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
 const jwt=coinbaseJwt("GET","/api/v3/brokerage/accounts?limit=250",{name:"test",secret:privateKey.export({type:"pkcs8",format:"pem"})},1000);
 const [h,p,s]=jwt.split(".");const payload=JSON.parse(Buffer.from(p,"base64url"));
 assert.equal(payload.uri,"GET api.coinbase.com/api/v3/brokerage/accounts");assert.equal(payload.exp,1120);
 assert.equal(verify("sha256",Buffer.from(h+"."+p),{key:publicKey,dsaEncoding:"ieee-p1363"},Buffer.from(s,"base64url")),true);
});
test("Coinbase account adapter rejects order placement resources",async()=>{
 await assert.rejects(()=>readCoinbase("/orders",{name:"test",secret:"invalid"}));
});

test("Coinbase Ed25519 credentials produce a independently verified signature",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const seed=privateKey.export({format:"der",type:"pkcs8"}).subarray(-32);
 const raw=Buffer.concat([seed,publicKey.export({format:"der",type:"spki"}).subarray(-32)]);
 const jwt=coinbaseJwt("GET","/api/v3/brokerage/accounts",{name:"test",secret:raw.toString("base64")},1000);
 const [h,p,s]=jwt.split(".");
 assert.equal(JSON.parse(Buffer.from(h,"base64url")).alg,"EdDSA");
 assert.equal(verify(null,Buffer.from(h+"."+p),publicKey,Buffer.from(s,"base64url")),true);
});

import {requireLiveAccount} from "./kayjay-state.mjs";
test("ATLAS simulated account fallback is excluded without live broker registration",()=>{
 assert.equal(requireLiveAccount({state:"CONNECTED",data:{positions:[]}},false).data,null);
 assert.equal(requireLiveAccount({state:"CONNECTED",data:{positions:[]}},true).state,"CONNECTED");
});
