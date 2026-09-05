const cache=new Map();
async function read(path){
 const saved=cache.get(path);if(saved&&Date.now()-saved.time<60000)return saved.value;
 const response=await fetch("https://api.dexscreener.com"+path,{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error("Discovery source unavailable");
 const value=await response.json();cache.set(path,{time:Date.now(),value});if(cache.size>80)cache.delete(cache.keys().next().value);return value;
}
export function pairView(p){
 const numeric=v=>v==null||v===""||!Number.isFinite(Number(v))?null:Number(v);
 return {chain:p.chainId,address:p.pairAddress,token:p.baseToken?.address,symbol:p.baseToken?.symbol||"Unknown",name:p.baseToken?.name||"Unknown",
 price:numeric(p.priceUsd),change:numeric(p.priceChange?.h24),liquidity:numeric(p.liquidity?.usd),volume:numeric(p.volume?.h24),
 marketCap:numeric(p.marketCap),created:p.pairCreatedAt||null};
}
export async function discover(query,feed){
 if(query.length>100||!["search","trending","latest"].includes(feed))throw new Error("Unsupported lookup");
 let pairs=[];
 if(feed==="latest"){
  const profiles=await read("/token-profiles/latest/v1");
  const selected=profiles.filter(p=>/^[a-z0-9-]+$/.test(p.chainId)&&/^[a-zA-Z0-9]+$/.test(p.tokenAddress)).slice(0,8);
  pairs=(await Promise.all(selected.map(p=>read("/token-pairs/v1/"+p.chainId+"/"+p.tokenAddress).catch(()=>[])))).flat();
 }else{
  const queries=feed==="trending"?["PEPE","BONK","WIF","DOGE","SHIB"]:[query||"PEPE"];
  pairs=(await Promise.all(queries.map(q=>read("/latest/dex/search?q="+encodeURIComponent(q))))).flatMap(r=>r.pairs||[]);
 }
 const rows=[...new Map(pairs.map(p=>[p.chainId+":"+p.pairAddress,pairView(p)])).values()];
 rows.sort((a,b)=>feed==="latest"?(b.created||0)-(a.created||0):(b.volume||0)-(a.volume||0));
 return {asOf:new Date().toISOString(),source:"DEX Screener",feed,pairs:rows.slice(0,30)};
}

export async function tokenCandles(chain,address){
 if(!/^[a-z0-9-]{1,30}$/.test(chain)||!/^[a-zA-Z0-9]{10,100}$/.test(address))throw new Error("Unsupported pool");
 const networks={ethereum:"eth",arbitrum:"arbitrum",bsc:"bsc",polygon:"polygon_pos",avalanche:"avax"};
 const network=networks[chain]||chain,key="ohlcv:"+chain+":"+address;
 const saved=cache.get(key);if(saved&&Date.now()-saved.time<60000)return saved.value;
 const response=await fetch("https://api.geckoterminal.com/api/v2/networks/"+network+"/pools/"+address+"/ohlcv/minute?aggregate=15&limit=100",{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error("Pool candles unavailable");
 const data=await response.json();
 const rows=data.data?.attributes?.ohlcv_list;
 if(!Array.isArray(rows))throw new Error("Pool candles unavailable");
 const candles=rows.filter(r=>Array.isArray(r)&&r.length===6&&r.every(Number.isFinite)).map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume})).sort((a,b)=>a.time-b.time);
 const value={source:"GeckoTerminal",asOf:new Date().toISOString(),candles};
 cache.set(key,{time:Date.now(),value});if(cache.size>80)cache.delete(cache.keys().next().value);return value;
}
