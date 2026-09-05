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
