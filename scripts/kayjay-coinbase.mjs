import {createPrivateKey,randomBytes,sign} from "node:crypto";
export function coinbaseCredentials(env=process.env){
 return {name:env.COINBASE_API_KEY_NAME||env.CDP_API_KEY_ID,secret:env.COINBASE_API_PRIVATE_KEY||env.CDP_API_KEY_SECRET};
}
export function coinbaseJwt(method,resource,credentials,now=Math.floor(Date.now()/1000)){
 if(!credentials.name||!credentials.secret)throw new Error("Coinbase API credentials are UNSET");
 const key=createPrivateKey(credentials.secret.replace(/\\n/g,"\n"));
 if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw new Error("Coinbase Advanced Trade requires a P-256 API key for this adapter");
 const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
 const header=encode({alg:"ES256",typ:"JWT",kid:credentials.name,nonce:randomBytes(16).toString("hex")});
 const payload=encode({sub:credentials.name,iss:"cdp",nbf:now,exp:now+120,uri:method+" api.coinbase.com"+resource.split("?")[0]});
 const input=header+"."+payload;
 return input+"."+sign("sha256",Buffer.from(input),{key,dsaEncoding:"ieee-p1363"}).toString("base64url");
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
export async function coinbaseSnapshot(){
 const credentials=coinbaseCredentials();
 if(!credentials.name||!credentials.secret){current={state:"AUTH REQUIRED",authenticated:false,ready:false,accounts:null,orders:null,fills:null,complete:false,reason:"Coinbase API credentials are UNSET"};return current;}
 if(cached&&Date.now()-cached.time<30000)return cached.promise;
 const promise=(async()=>{
 const started=Date.now();
 try{
  const accounts=[];let cursor="",more=true;
  for(let page=0;page<5&&more;page++){
   const data=await readCoinbase("/accounts?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):""),credentials);
   if(!Array.isArray(data.accounts))throw new Error("Coinbase account schema unavailable");
   accounts.push(...data.accounts.map(a=>({currency:a.currency,available:a.available_balance?.value??null,held:a.hold?.value??null,active:a.active===true,ready:a.ready===true})));
   more=data.has_next===true;cursor=data.cursor||"";if(more&&!cursor)break;
  }
  const [orders,fills]=await Promise.allSettled([readCoinbase("/orders/historical/batch?limit=100&order_status=OPEN",credentials),readCoinbase("/orders/historical/fills?limit=100",credentials)]);
  const orderRows=orders.status==="fulfilled"&&Array.isArray(orders.value.orders)?orders.value.orders.map(o=>({id:o.order_id,symbol:o.product_id,side:o.side,status:o.status,filled_size:o.filled_size,average_filled_price:o.average_filled_price})):null;
  const fillRows=fills.status==="fulfilled"&&Array.isArray(fills.value.fills)?fills.value.fills.map(f=>({id:f.entry_id,symbol:f.product_id,side:f.side,size:f.size,price:f.price,time:f.trade_time})):null;
  return {state:"CONNECTED",authenticated:true,ready:accounts.some(a=>a.ready),asOf:new Date().toISOString(),latencyMs:Date.now()-started,accounts,accountsComplete:!more,orders:orderRows,fills:fillRows,complete:false,reason:"Account reads only; order/fill history is a bounded page. Trading and money movement require existing authority."};
 }catch{return {state:"UNAVAILABLE",authenticated:null,ready:false,accounts:null,orders:null,fills:null,complete:false,reason:"Coinbase account authentication or request failed"};}
 })().then(value=>{current=value;return value;});cached={time:Date.now(),promise};return promise;
}
