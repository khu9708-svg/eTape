export function connectionState(name,data){
 const failed=data==null||typeof data!=="object"||Boolean(data.error)||data.ok===false;
 if(failed)return {state:"DEGRADED",authenticated:null,ready:false,reason:"Service returned an error; account data is unavailable"};
 if(name==="Robinhood")return {state:data.connected===true?"CONNECTED":"LOGIN REQUIRED",authenticated:data.connected===true,ready:null,reason:"Gateway authentication does not prove execution readiness"};
 if(["Webull","OANDA"].includes(name)){
  const auth=data.checks?.authentication??data.probe?.checks?.authentication??null;
  return {state:data.ready===true&&auth===true?"CONNECTED":auth===false?"AUTH REQUIRED":"DEGRADED",authenticated:auth,ready:data.ready===true,reason:data.ready===true?"Readiness reported by engine":"Engine broker readiness not satisfied"};
 }
 if(name==="JINX"&&data.running===false)return {state:"DEGRADED",authenticated:null,ready:false,reason:"Worker responds; engine is not running"};
 return {state:"CONNECTED",authenticated:null,ready:null,reason:null};
}
export function sourceData(name,response){
 return {engine:name,available:response.state==="CONNECTED"&&response.data!=null&&!response.data.error,
  state:response.state,lastSuccess:response.lastSuccess??null,data:response.data};
}
