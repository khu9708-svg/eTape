import { useEffect, useState } from "react";
import { useTheme } from "../ThemeProvider";
import type { PanelProps } from "./registry";

type Service = { name: string; state: string; ms: number | null; data: Record<string, unknown> | null };
type Snapshot = { updatedAt: string; services: Service[]; raptor: {state: string; text: string; updatedAt: string | null} };

export function KayjayPanel({config}: PanelProps): JSX.Element {
  const {palette} = useTheme();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState(String(config.settings["view"] || "Health"));
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/kayjay/status", {signal: AbortSignal.timeout(8000)});
        if (!response.ok) throw new Error("Unavailable");
        const next = await response.json() as Snapshot;
        if (active) { setSnapshot(next); setError(false); }
      } catch { if (active) setError(true); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const [portfolio,setPortfolio]=useState<{asOf:string;accounts:{account:string;total:number|null;cash:number|null;crypto:number|null;currency:string;error?:string}[]}|null>(null);
  const [portfolioError,setPortfolioError]=useState(false);
  useEffect(()=>{
    if(tab!=="Accounts")return;
    let active=true;
    const poll=async()=>{try{
      const response=await fetch("/kayjay/portfolio",{signal:AbortSignal.timeout(35000)});
      if(!response.ok)throw new Error("Unavailable");
      const data=await response.json();
      if(active){setPortfolio(data);setPortfolioError(false);}
    }catch{if(active)setPortfolioError(true);}};
    void poll();const timer=setInterval(()=>void poll(),30000);
    return()=>{active=false;clearInterval(timer);};
  },[tab]);
  useEffect(()=>{
    const navigate=(event:Event)=>{const name=(event as CustomEvent<string>).detail;setTab(config.settings["view"]==="nav"?name:name==="Dashboard"||name==="Markets"||name==="Meme Coins"?"Health":name==="Brokers"?"Accounts":name);};
    window.addEventListener("kayjay-section",navigate);return()=>window.removeEventListener("kayjay-section",navigate);
  },[]);
  const [modeResult,setModeResult]=useState("");
  const [modeBusy,setModeBusy]=useState(false);
  const changeMode=async(engine:string,mode:string)=>{
    if(!window.confirm("Change "+engine+" to "+mode+" through its existing authority? "+(mode==="AUTO"?"AUTO can permit real trades under that engine's risk gates.":"")))return;
    setModeBusy(true);setModeResult("Waiting for engine confirmation...");
    try{const response=await fetch("/kayjay/mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({engine,mode,confirm:true}),signal:AbortSignal.timeout(16000)});const result=await response.json();if(!response.ok)throw new Error(result.error||"Engine rejected request");
     setModeResult("Engine accepted request. Refreshing authoritative mode...");const state=await fetch("/kayjay/status");if(!state.ok)throw new Error("Mode response received; health refresh unavailable");setSnapshot(await state.json());setModeResult("Mode response received from "+engine+".");
    }catch(error){setModeResult(error instanceof Error?error.message:"Request failed; current mode unknown");}finally{setModeBusy(false);}
  };
  if(config.settings["view"]==="nav")return <nav className="kayjay-nav" aria-label="KAYJAY navigation">{["Dashboard","JINX","ATLAS","RAPTOR15","Markets","Meme Coins","Orders","Positions","Brokers","Settings"].map(name=><button key={name} aria-current={(tab==="Health"?"Dashboard":tab)===name?"page":undefined} onClick={()=>window.dispatchEvent(new CustomEvent("kayjay-section",{detail:name}))}>{name}</button>)}<small>Existing engines.<br/>One control surface.</small></nav>;
  const atlas = snapshot?.services.find(s => s.name === "ATLAS");
  const jinx = snapshot?.services.find(s => s.name === "JINX");
  return <div className="kayjay-system" style={{height:"100%",overflow:"auto",padding:12,color:palette.text,fontSize:12}}>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
      {["Health","Accounts"].map(name =>
        <button key={name} onClick={() => setTab(name)} aria-pressed={tab===name}>{name}</button>)}
    </div>
    {tab!=="Health" && <p style={{color:palette.textMuted}}>Engine authority · OFF / MANUAL / AUTO</p>}
    {error && <p role="alert" style={{color:palette.danger}}>Connection lost. Last received data is stale; trading readiness is unknown.</p>}
    {!snapshot && !error && <p>Connecting to the existing services…</p>}
    {modeResult&&<p role="status">{modeResult}</p>}
    {snapshot && tab==="Health" && <>
      <div className="kayjay-overview-metrics"><div><small>Global readiness</small><strong className="negative">{error?"STALE":atlas?.state==="CONNECTED"&&jinx?.state==="CONNECTED"?"CHECK ENGINE GATES":"DEGRADED"}</strong></div><div><small>Live P&amp;L</small><strong>Unavailable</strong></div></div>
      <div className="kayjay-engine-cards">{["JINX","ATLAS","RAPTOR15"].map(name=>{
        const service=snapshot.services.find(s=>s.name===name);const scanner=name==="RAPTOR15";
        const mode=scanner?"READ ONLY":String(service?.data?.["mode"]??service?.data?.["execution_mode"]??"UNKNOWN");
        const state=error?"STALE":scanner?snapshot.raptor.state:service?.state??"UNKNOWN";
        return <article key={name}><div><strong>{name}</strong><span className={state==="CONNECTED"||state==="READ ONLY"?"positive":"negative"}>{state}</span></div>
          <p>Mode <b>{mode}</b> <small>{service?.ms!=null?service.ms+" ms":scanner?"Live market reader":"Authority unavailable"}</small></p>
          <div className="kayjay-modes" aria-label={name+" mode controls"}>{["OFF","MANUAL","AUTO"].map(m=><button key={m} disabled={scanner||error||modeBusy||service?.state!=="CONNECTED"||(name==="JINX"&&m==="OFF")} onClick={()=>void changeMode(name,m)} title={scanner?"Existing scanner is read only; no execution mode endpoint":service?.state==="CONNECTED"?"Use the engine control below":"Engine authority offline; no mode command can be verified"}>{m}</button>)}<button onClick={()=>setTab(name)}>Open {name}</button></div>
        </article>;
      })}</div>
      <h3>Connections</h3><div className="kayjay-connections">{["Bluelights","Robinhood","Webull","OANDA","Kalshi"].map(name=>{
       const service=snapshot.services.find(s=>s.name===name);const state=error?"STALE":service?.state??"UNVERIFIED";
       return <div key={name}><span>{name}</span><b className={state==="CONNECTED"?"positive":"negative"}>{state}</b><small>{service?.ms!=null?service.ms+" ms":"Readiness unavailable"}</small></div>;
      })}</div>
      <div className="kayjay-position-summary"><button onClick={()=>setTab("Positions")}>Positions · {snapshot.services.find(s=>s.name==="Positions")?.state==="CONNECTED"?"View live":"Unavailable"}</button><button onClick={()=>setTab("Orders")}>Orders · {snapshot.services.find(s=>s.name==="Orders")?.state==="CONNECTED"?"View live":"Unavailable"}</button></div>
      <p className="kayjay-help">Execution controls remain with each engine. Offline is not the same as mode OFF. No global P&amp;L is inferred from practice balances.</p>
      <small>Last health check {new Date(snapshot.updatedAt).toLocaleTimeString()}</small>
    </>}
    {tab==="Settings" && <p>Use Settings in the top bar for the existing eTape settings. Engine authority is controlled in its own system view.</p>}
    {tab==="Accounts" && <>
      <p>Robinhood · Real account values · Read only</p>
      {portfolioError && <p role="alert">Portfolio unavailable; retained values are stale.</p>}
      {!portfolio&&!portfolioError && <p>Reading the existing Robinhood gateway...</p>}
      {portfolio && <><table style={{width:"100%"}}><thead><tr><th>Account</th><th>Total value</th><th>Cash</th><th>Crypto</th></tr></thead>
       <tbody>{portfolio.accounts.map(a=><tr key={a.account}><td>{a.account}</td>{[a.total,a.cash,a.crypto].map((v,i)=><td key={i}>{v===null?"Unavailable":v.toLocaleString("en-US",{style:"currency",currency:a.currency})}</td>)}</tr>)}</tbody></table>
       <p>Received {new Date(portfolio.asOf).toLocaleTimeString()}. P&amp;L unavailable from this gateway response.</p></>}
    </>}
    {tab==="ATLAS" && <>
      {atlas?.state==="CONNECTED" && !error
        ? <iframe title="ATLAS existing execution cockpit" src="http://127.0.0.1:8080/" style={{width:"100%",height:"85%",minHeight:450,border:0}} />
        : <p>ATLAS is offline. Its existing dashboard and OFF / MANUAL / AUTO authority will appear here when running. The launcher does not enable a disabled engine.</p>}
    </>}
    {tab==="JINX" && <><p>Existing JINX worker · {error?"STALE":jinx?.state ?? "CONNECTING"}</p>
      <pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify({status:jinx?.data??{state:"Worker offline; execution authority unchanged"},discovery:snapshot?.services.find(s=>s.name==="JINX discovery")?.data??{state:"JINX discovery feed unavailable"}},null,2)}</pre></>}
    {snapshot && tab==="RAPTOR15" && <><p>{snapshot.raptor.state} · Existing live reader · No order placement</p>
      <pre style={{whiteSpace:"pre-wrap",lineHeight:1.6}}>{snapshot.raptor.text}</pre>
      <p>{snapshot.raptor.updatedAt ? new Date(snapshot.raptor.updatedAt).toLocaleString() : "Waiting for first live window"}</p></>}
    {snapshot && ["Positions","Orders"].includes(tab) && <>
      <p>ATLAS {tab.toLowerCase()} · live engine response</p>
      <pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(snapshot.services.find(s=>s.name===tab)?.data ?? {state:"Unavailable; not a zero balance"},null,2)}</pre>
      <p>Use the ATLAS tab for its existing preview and approval controls.</p>
    </>}
  </div>;
}
