import {createPrivateKey,randomBytes,sign} from "node:crypto";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {loadEnvFile} from "node:process";
const credentialFile=join(homedir(),".eTape","coinbase.env");
if(existsSync(credentialFile))loadEnvFile(credentialFile);
export function coinbaseCredentials(env=process.env){
 return {name:env.COINBASE_API_KEY_NAME||env.CDP_API_KEY_ID,secret:env.COINBASE_API_PRIVATE_KEY||env.CDP_API_KEY_SECRET};
}
export function coinbaseJwt(method,resource,credentials,now=Math.floor(Date.now()/1000)){
 if(!credentials.name||!credentials.secret)throw new Error("Coinbase API credentials are UNSET");
 const secret=credentials.secret.replace(/\\n/g,"\n").trim();
 let key;
 if(secret.startsWith("-----BEGIN"))key=createPrivateKey(secret);
 else {
  const raw=Buffer.from(secret,"base64");
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(secret)||![32,64].includes(raw.length))throw new Error("Invalid Coinbase signing key format");
  key=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),raw.subarray(0,32)]),format:"der",type:"pkcs8"});
 }
 const ed=key.asymmetricKeyType==="ed25519";
 if(!ed&&(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1"))throw new Error("Unsupported Coinbase signing key type");
 const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
 const header=encode({alg:ed?"EdDSA":"ES256",typ:"JWT",kid:credentials.name,nonce:randomBytes(16).toString("hex")});
 const payload=encode({sub:credentials.name,iss:"cdp",nbf:now,exp:now+120,uri:method+" api.coinbase.com"+resource.split("?")[0]});
 const input=header+"."+payload;
 return input+"."+sign(ed?null:"sha256",Buffer.from(input),ed?key:{key,dsaEncoding:"ieee-p1363"}).toString("base64url");
}
const resources=new Set(["/accounts","/orders/historical/batch","/orders/historical/fills"]);
export async function readCoinbase(resource,credentials=coinbaseCredentials(),send=fetch){
 const path=resource.split("?")[0];if(!resources.has(path))throw new Error("Unsupported account read");
 const uri="/api/v3/brokerage"+resource;
 const response=await send("https://api.coinbase.com"+uri,{headers:{Authorization:"Bearer "+coinbaseJwt("GET",uri,credentials)},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error(response.status===401||response.status===403?"Coinbase authorization required":"Coinbase account service unavailable");
 const data=await response.json();if(data.error)throw new Error("Coinbase account request failed");return data;
}
let cached;
let current={state:"UNVERIFIED",authenticated:null,ready:false,reason:"Coinbase account check has not completed"};
export function coinbaseCurrent(){return current;}
export async function collectCoinbase(resource,field,credentials,send=fetch){
 const rows=[],seen=new Set();let cursor="";
 for(let page=0;page<5;page++){
  const data=await readCoinbase(resource+(cursor?"&cursor="+encodeURIComponent(cursor):""),credentials,send);
  if(!Array.isArray(data[field]))throw new Error("Coinbase account schema unavailable");
  rows.push(...data[field]);
  const more=data.has_next===true||(field==="fills"&&data.has_next===undefined&&Boolean(data.cursor)&&data[field].length>0);
  if(!more)return {rows,complete:true};
  if(!data.cursor||seen.has(data.cursor))return {rows,complete:false};
  cursor=data.cursor;seen.add(cursor);
 }
 return {rows,complete:false};
}
export async function readCoinbaseSnapshot(credentials,send=fetch){
 const started=Date.now();
 const specs=[['accounts','/accounts?limit=250','accounts'],['orders','/orders/historical/batch?limit=100&order_status=OPEN','orders'],['fills','/orders/historical/fills?limit=100','fills'],['history','/orders/historical/batch?limit=100&order_status=FILLED','orders']];
 const results=await Promise.allSettled(specs.map(([,resource,field])=>collectCoinbase(resource,field,credentials,send)));
 const out={asOf:new Date().toISOString(),latencyMs:Date.now()-started};
 const order=o=>({id:o.order_id,symbol:o.product_id,side:o.side,status:o.status,filled_size:o.filled_size,average_filled_price:o.average_filled_price});
 const projections={accounts:a=>({currency:a.currency,available:a.available_balance?.value??null,held:a.hold?.value??null,active:a.active===true,ready:a.ready===true}),orders:order,history:order,fills:f=>({id:f.entry_id,symbol:f.product_id,side:f.side,size:f.size,price:f.price,time:f.trade_time})};
 results.forEach((result,i)=>{const name=specs[i][0];out[name]=result.status==='fulfilled'?result.value.rows.map(projections[name]):null;out[name+'Complete']=result.status==='fulfilled'&&result.value.complete;});
 const any=results.some(r=>r.status==='fulfilled');
 const complete=specs.every(([name])=>out[name+'Complete']);
 return {...out,state:complete?'CONNECTED':any?'DEGRADED':'UNAVAILABLE',authenticated:any?true:null,ready:out.accounts?.some(a=>a.ready)??false,complete,reason:complete?'All account, open-order, fill and filled-order pages reconciled. Trading readiness is separate.':'One or more account/history reads failed or reached the page limit; missing data is not a zero balance.'};
}
export async function coinbaseSnapshot(){
 const credentials=coinbaseCredentials();
 if(!credentials.name||!credentials.secret){current={state:"AUTH REQUIRED",authenticated:false,ready:false,accounts:null,orders:null,fills:null,complete:false,reason:"Coinbase API credentials are UNSET"};return current;}
 if(cached&&Date.now()-cached.time<30000)return cached.promise;
 const promise=readCoinbaseSnapshot(credentials).then(value=>{current=value;return value;});cached={time:Date.now(),promise};return promise;
}
