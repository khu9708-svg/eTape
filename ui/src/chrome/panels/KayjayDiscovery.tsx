import {createChart,CandlestickSeries,ColorType,type UTCTimestamp} from "lightweight-charts";
import {useEffect,useRef,useState} from "react";
type Pair={chain:string;address:string;token:string;symbol:string;name:string;price:number|null;change:number|null;liquidity:number|null;volume:number|null;marketCap:number|null};
const amount=(v:number|null)=>v===null?"Unavailable":v.toLocaleString("en-US",{maximumFractionDigits:8});
export function KayjayDiscovery():JSX.Element{
 const [query,setQuery]=useState("");const [feed,setFeed]=useState("trending");const [request,setRequest]=useState("");
 const [rows,setRows]=useState<Pair[]>([]);const [selected,setSelected]=useState<Pair|null>(null);const [state,setState]=useState("Loading");const [stamp,setStamp]=useState("");
 useEffect(()=>{let active=true;const poll=async()=>{try{
  const response=await fetch("/kayjay/discovery?feed="+feed+"&q="+encodeURIComponent(request),{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error();const data=await response.json();if(active){setRows(data.pairs);setStamp(data.asOf);setState("Live");}
 }catch{if(active)setState("Unavailable / stale");}};
 void poll();const timer=setInterval(()=>void poll(),60000);return()=>{active=false;clearInterval(timer);};},[request,feed]);
 return <section className="kayjay-discovery">
  <form onSubmit={e=>{e.preventDefault();setState("Loading");setSelected(null);setFeed("search");setRequest(query.trim());}}>
   <input aria-label="Token name, symbol or contract" placeholder="Search token name, symbol or contract address" value={query} maxLength={100} onChange={e=>setQuery(e.target.value)}/><button>Search tokens</button>
  </form>
  <div className="kayjay-discovery-tabs"><button onClick={()=>{setFeed("trending");setSelected(null);}}>Active meme pairs</button><button onClick={()=>{setFeed("latest");setSelected(null);}}>New token profiles</button><span>{state} · DEX Screener</span></div>
  {selected?<><button onClick={()=>setSelected(null)}>← Search results</button><h2>{selected.symbol} <small>{selected.name}</small></h2><p>{selected.chain} · Contract {selected.token}</p>
   <p>Price $ {amount(selected.price)} · Liquidity $ {amount(selected.liquidity)} · Volume 24h $ {amount(selected.volume)} · Market cap USD {amount(selected.marketCap)}</p>
   <KayjayTokenChart pair={selected}/>
  </>:<><p>{feed==="trending"?"PEPE / BONK / WIF / DOGE / SHIB search matches, ranked by reported 24h volume.":"Live token lookup. Names are not unique; verify the chain and contract."}</p>
   <div className="kayjay-token-results"><table><thead><tr><th>Token / chain</th><th>Price USD</th><th>24h</th><th>Liquidity USD</th><th>Volume USD</th></tr></thead><tbody>{rows.map(p=><tr key={p.chain+p.address}><td><button onClick={()=>setSelected(p)}>{p.symbol}</button><small>{p.chain} · {p.name}</small></td><td>{amount(p.price)}</td><td className={(p.change??0)<0?"negative":"positive"}>{amount(p.change)}%</td><td>{amount(p.liquidity)}</td><td>{amount(p.volume)}</td></tr>)}</tbody></table></div>
   {rows.length===0&&state==="Live"&&<p>No matching pairs.</p>}<small>Updated {stamp?new Date(stamp).toLocaleTimeString():"—"} · Refresh 60s · Read only</small></>}
 </section>;
}
export function KayjayTradingView({symbol}:{symbol:string}):JSX.Element{
 const host=useRef<HTMLDivElement>(null);const [failed,setFailed]=useState(false);
 useEffect(()=>{if(!host.current)return;setFailed(false);const wrapper=document.createElement("div");wrapper.className="tradingview-widget-container";wrapper.style.height="100%";
 const inner=document.createElement("div");inner.className="tradingview-widget-container__widget";inner.style.height="calc(100% - 24px)";wrapper.appendChild(inner);
 const credit=document.createElement("a");credit.href="https://www.tradingview.com/";credit.target="_blank";credit.rel="noreferrer";credit.textContent="Charts by TradingView";wrapper.appendChild(credit);
 const script=document.createElement("script");script.src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";script.async=true;
 script.textContent=JSON.stringify({autosize:true,symbol:"COINBASE:"+symbol+"USD",interval:"60",timezone:"exchange",theme:"dark",style:"1",locale:"en",allow_symbol_change:true,backgroundColor:"#080808",gridColor:"rgba(255,255,255,0.04)",hide_side_toolbar:false,calendar:false,support_host:"https://www.tradingview.com"});
 script.onerror=()=>setFailed(true);wrapper.appendChild(script);host.current.appendChild(wrapper);
 return()=>wrapper.remove();},[symbol]);
 return <div className="kayjay-tv"><div ref={host} style={{height:"100%"}}/>{failed&&<p role="alert">TradingView unavailable. Select Native chart.</p>}</div>;
}

function KayjayTokenChart({pair}:{pair:Pair}):JSX.Element{
 const host=useRef<HTMLDivElement>(null);const [state,setState]=useState("Loading candles");
 useEffect(()=>{
  if(!host.current)return;let active=true;
  const chart=createChart(host.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:"#080808"},textColor:"#aaa",fontSize:14},grid:{vertLines:{color:"#202020"},horzLines:{color:"#202020"}},timeScale:{timeVisible:true}});
  const series=chart.addSeries(CandlestickSeries,{upColor:"#00d99b",downColor:"#ff526b",borderVisible:false,wickUpColor:"#00d99b",wickDownColor:"#ff526b",priceFormat:{type:"price",precision:8,minMove:0.00000001}});
  let fitted=false;
  const poll=async()=>{try{const response=await fetch("/kayjay/token-candles?chain="+encodeURIComponent(pair.chain)+"&address="+encodeURIComponent(pair.address),{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error();
   const data=await response.json();if(active){series.setData(data.candles.map((c:{time:number;open:number;high:number;low:number;close:number})=>({...c,time:c.time as UTCTimestamp})));if(!fitted){chart.timeScale().fitContent();fitted=true;}setState(data.candles.length?"Live 15m candles · "+new Date(data.asOf).toLocaleTimeString():"No candle history for this pool");}
  }catch{if(active)setState("Candles unavailable; retained data may be stale");}};
  void poll();const timer=setInterval(()=>void poll(),60000);
  return()=>{active=false;clearInterval(timer);chart.remove();};
 },[pair.chain,pair.address]);
 return <><div ref={host} className="kayjay-token-chart" aria-label="Selected token chart"/><small>{state} · <a href="https://www.geckoterminal.com/" target="_blank" rel="noreferrer">GeckoTerminal</a> · Read only</small></>;
}
