import {useEffect,useRef,useState} from "react";
import {CandlestickSeries,ColorType,createChart,HistogramSeries,type IChartApi,type ISeriesApi,type UTCTimestamp} from "lightweight-charts";
import type {PanelProps} from "./registry";
import {useTheme} from "../ThemeProvider";
type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
type Market={source:string;asOf:string;latencyMs:number;symbol:string;quotes:{symbol:string;price:number;change24h:number|null}[];candles:Candle[];bids:number[][];asks:number[][]};
const images:Record<string,string>={BTC:"bitcoin",ETH:"ethereum",SOL:"solana"};
let focused="BTC";
const money=(n:number)=>n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
export function KayjayMarketsPanel({config}:PanelProps):JSX.Element {
 const {palette}=useTheme();
 const [symbol,setSymbol]=useState(focused);
 const [seconds,setSeconds]=useState(60);
 const [data,setData]=useState<Market|null>(null);
 const [failed,setFailed]=useState(false);
 const host=useRef<HTMLDivElement>(null);
 const chart=useRef<IChartApi|null>(null);
 const candles=useRef<ISeriesApi<"Candlestick">|null>(null);
 const volume=useRef<ISeriesApi<"Histogram">|null>(null);
 const fitted=useRef(false);
 const book=config.settings["view"]==="book";
 useEffect(()=>{
   const changed=()=>{setSymbol(focused);setData(null);fitted.current=false;};
   window.addEventListener("kayjay-market",changed);
   return ()=>window.removeEventListener("kayjay-market",changed);
 },[]);
 useEffect(()=>{
   let active=true;
   const poll=async()=>{
     try{
       const response=await fetch("/kayjay/markets?symbol="+symbol+"&seconds="+seconds,{signal:AbortSignal.timeout(10000)});
       if(!response.ok) throw new Error("Market unavailable");
       const next=await response.json() as Market;
       if(active){setData(next);setFailed(false);}
     }catch{if(active)setFailed(true);}
   };
   void poll();const timer=setInterval(()=>void poll(),5000);
   return ()=>{active=false;clearInterval(timer);};
 },[symbol,seconds]);
 useEffect(()=>{
   if(book||!host.current)return;
   const api=createChart(host.current,{autoSize:true,
     layout:{background:{type:ColorType.Solid,color:palette.bg},textColor:palette.textMuted,fontSize:14,fontFamily:"IBM Plex Sans, sans-serif"},
     grid:{vertLines:{color:palette.grid},horzLines:{color:palette.grid}},
     timeScale:{timeVisible:true,secondsVisible:false,borderColor:palette.border},
     rightPriceScale:{borderColor:palette.border},crosshair:{vertLine:{color:palette.accent},horzLine:{color:palette.accent}}});
   chart.current=api;
   candles.current=api.addSeries(CandlestickSeries,{upColor:palette.up,downColor:palette.down,borderVisible:false,wickUpColor:palette.up,wickDownColor:palette.down});
   volume.current=api.addSeries(HistogramSeries,{priceFormat:{type:"volume"},priceScaleId:"volume"});
   api.priceScale("volume").applyOptions({scaleMargins:{top:0.83,bottom:0}});
   fitted.current=false;
   return ()=>{api.remove();chart.current=null;candles.current=null;volume.current=null;};
 },[book,palette]);
 useEffect(()=>{
   if(!data||!candles.current||!volume.current)return;
   candles.current.setData(data.candles.map(c=>({...c,time:c.time as UTCTimestamp})));
   volume.current.setData(data.candles.map(c=>({time:c.time as UTCTimestamp,value:c.volume,color:c.close>=c.open?palette.volUp:palette.volDown})));
   if(!fitted.current){chart.current?.timeScale().fitContent();fitted.current=true;}
 },[data,palette]);
 const current=data?.quotes.find(q=>q.symbol===symbol);
 return <div className="kayjay-markets">
   {!book && <div className="kayjay-coins">{["BTC","ETH","SOL"].map(coin=>{
     const quote=data?.quotes.find(q=>q.symbol===coin);
     return <button key={coin} className="kayjay-coin" aria-pressed={coin===symbol} onClick={()=>{focused=coin;window.dispatchEvent(new Event("kayjay-market"));}}>
       <img src={"/"+images[coin]+".png"} alt={coin+" logo"} width={48} height={48}/>
       <span><strong>{coin} <small>/ USD</small></strong><b>{quote?"$"+money(quote.price):"Connecting"}</b></span>
       <em className={quote && (quote.change24h??0)<0?"negative":"positive"}>{quote?.change24h==null?"—":(quote.change24h>=0?"+":"")+quote.change24h.toFixed(2)+"%"}</em>
     </button>;
   })}</div>}
   <div className="kayjay-market-toolbar">
     <strong>{symbol} / USD {book?"· Order book":""}</strong>
     {!book && <div>{[[60,"1m"],[300,"5m"],[900,"15m"],[3600,"1h"],[86400,"1D"]].map(([value,label])=>
       <button key={value} aria-pressed={seconds===value} onClick={()=>{setSeconds(Number(value));fitted.current=false;}}>{label}</button>)}</div>}
     <span className={failed?"negative":"positive"}>{failed?"STALE / UNAVAILABLE":data?"LIVE QUOTES":"CONNECTING"}</span>
   </div>
   {book ? <div className="kayjay-book">
     <div className="kayjay-book-price">{current?"$"+money(current.price):"—"}</div>
     <table><thead><tr><th>Bid size</th><th>Bid · USD</th><th>Ask · USD</th><th>Ask size</th></tr></thead>
     <tbody>{(data?.bids??[]).map((bid,i)=><tr key={i}>
       <td>{bid[1]?.toFixed(4)}</td><td className="positive">{money(bid[0])}</td>
       <td className="negative">{data?.asks[i]?money(data.asks[i][0]):"—"}</td><td>{data?.asks[i]?.[1]?.toFixed(4)??"—"}</td>
     </tr>)}</tbody></table>
   </div> : <div ref={host} className="kayjay-live-chart"/>}
   <div className="kayjay-feed-caption">{failed?"Feed unavailable; displayed data may be stale.":data?.source??"Coinbase Exchange"} · Quotes / book refresh 5s · {data?new Date(data.asOf).toLocaleTimeString():"Waiting"} · Read only</div>
 </div>;
}
