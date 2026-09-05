import { useEffect, useState } from "react";
import { useTheme } from "../ThemeProvider";
import type { PanelProps } from "./registry";

type Service = { name: string; state: string; ms: number | null; authenticated?:boolean|null; ready?:boolean|null; lastSuccess?:string|null; data: Record<string, unknown> | null };
type Snapshot = { updatedAt: string; services: Service[]; raptor: {state: string; text: string; updatedAt: string | null} };
type CoinbaseOrder = {id?:string;symbol?:string;side?:string;status?:string;filled_size?:string|null;average_filled_price?:string|null};
type CoinbaseSnapshot = {
  state:string; authenticated?:boolean; ready?:boolean; asOf?:string; reason?:string;
  accounts:{currency?:string;available?:string|null;held?:string|null}[]|null;
  orders:CoinbaseOrder[]|null; history:CoinbaseOrder[]|null;
  fills:{id?:string;symbol?:string;side?:string;size?:string|null;price?:string|null;time?:string}[]|null;
  accountsComplete?:boolean;ordersComplete?:boolean;fillsComplete?:boolean;historyComplete?:boolean;complete?:boolean;
};
const coinbaseValue = (value: string | null | undefined) => value == null || value === "" ? "Unavailable" : value;

function CoinbaseOrders({label,orders,complete}:{label:string;orders:CoinbaseOrder[]|null|undefined;complete:boolean|undefined}): JSX.Element {
  return <section><h4>{label}{complete !== true && " · Incomplete"}</h4>
    {orders == null ? <p>Unavailable</p> : orders.length === 0 ? <p>None returned{complete !== true && "; coverage incomplete"}.</p> :
      <table style={{width:"100%"}}><thead><tr><th>Market</th><th>Side</th><th>Status</th><th>Filled size</th><th>Average price</th></tr></thead>
        <tbody>{orders.map((order,index)=><tr key={order.id??index}><td>{coinbaseValue(order.symbol)}</td><td>{coinbaseValue(order.side)}</td><td>{coinbaseValue(order.status)}</td><td>{coinbaseValue(order.filled_size)}</td><td>{coinbaseValue(order.average_filled_price)}</td></tr>)}</tbody>
      </table>}
  </section>;
}

type PaymentResult = {
  error?:string;code?:string;message?:string;state?:string;paymentUrl?:string;
  order?:{orderId?:string;status?:string;paymentTotal?:string;paymentCurrency?:string;purchaseAmount?:string;purchaseCurrency?:string;fees?:{amount?:string;currency?:string}[]};
};

type TradeResult = {error?:string;code?:string;mode?:string;state?:string;clientOrderId?:string;coinbaseOrderId?:string|null;rejectReason?:string|null;note?:string;duplicate?:boolean;filledSize?:string|null};

// Coinbase Advanced Trade, gated by the KAYJAY Coinbase execution mode.
// A live order is OWNER LIVE VERIFY REQUIRED — placed only on explicit confirm.
function CoinbaseTrading(): JSX.Element {
  const [mode,setMode]=useState<string>("");
  const [product,setProduct]=useState("BTC-USD");
  const [side,setSide]=useState("BUY");
  const [quoteSize,setQuoteSize]=useState("");
  const [confirmed,setConfirmed]=useState(false);
  const [result,setResult]=useState<TradeResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");
  async function trade(body:Record<string,unknown>):Promise<TradeResult|null> {
    if(busy)return null; setBusy(true); setMsg("");
    try {
      const r=await fetch("/kayjay/trade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const data=await r.json() as TradeResult;
      if(!r.ok||data.error){setMsg(data.error??"Trade request rejected.");return data;}
      return data;
    } catch { setMsg("Coinbase trade endpoint unavailable. Verify order state in Coinbase before retrying."); return null; }
    finally { setBusy(false); }
  }
  useEffect(()=>{fetch("/kayjay/trade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"mode"})}).then(r=>r.json()).then((d:TradeResult)=>{if(d?.mode)setMode(d.mode);}).catch(()=>setMode("OFF"));},[]);
  async function setExecMode(next:string){const d=await trade({action:"mode",owner:true,confirm:true,input:{mode:next}});if(d?.mode)setMode(d.mode);}
  async function submit(){
    const clientOrderId="kj-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
    const d=await trade({action:"submit",owner:true,confirm:true,input:{clientOrderId,productId:product,side,type:"MARKET",quoteSize}});
    setResult(d);setConfirmed(false);
    if(d?.state==="submitted")setMsg("Order reached Coinbase. It is not a fill — reconcile for status.");
  }
  return <details><summary>Coinbase trading · mode {mode||"…"}</summary>
    <p>Face → KAYJAY Coinbase execution authority → Coinbase. OFF blocks all orders. A live order is placed only on explicit owner confirmation (OWNER LIVE VERIFY REQUIRED).</p>
    <fieldset disabled={busy} style={{border:0,padding:0}}>
      <p>Mode: {["OFF","MANUAL","AUTO"].map(m=><button key={m} disabled={m===mode} style={{marginRight:4}} onClick={()=>void setExecMode(m)}>{m}</button>)}</p>
      {mode!=="OFF"&&<>
        <label style={{display:"block",margin:"6px 0"}}>Product <input value={product} onChange={e=>{setProduct(e.target.value.trim().toUpperCase());setConfirmed(false);}}/></label>
        <label style={{display:"block",margin:"6px 0"}}>Side <select value={side} onChange={e=>{setSide(e.target.value);setConfirmed(false);}}><option>BUY</option><option>SELL</option></select></label>
        <label style={{display:"block",margin:"6px 0"}}>{side==="BUY"?"Quote size (USD)":"Base size"} <input inputMode="decimal" value={quoteSize} onChange={e=>{setQuoteSize(e.target.value);setConfirmed(false);}}/></label>
        <label style={{display:"block",margin:"6px 0"}}><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I confirm this live Coinbase order.</label>
        <button disabled={!quoteSize||!confirmed} onClick={()=>void submit()}>Place live order</button>
      </>}
      {result?.clientOrderId&&<button style={{marginLeft:8}} onClick={()=>void trade({action:"reconcile",input:{clientOrderId:result.clientOrderId}}).then(d=>setResult(d))}>Reconcile</button>}
    </fieldset>
    {result&&<p>Order {result.clientOrderId}: {result.state}{result.coinbaseOrderId?` · ${result.coinbaseOrderId}`:""}{result.rejectReason?` · ${result.rejectReason}`:""}{result.filledSize?` · filled ${result.filledSize}`:""}</p>}
    {msg&&<p role="alert">{msg}</p>}
  </details>;
}

type CashoutRail = {rail?:string;label?:string;candidate?:boolean;reason?:string;paymentMethodId?:string|null;methodType?:string;requiresSession?:boolean};
type CashoutState = {error?:string;authenticated?:boolean;country?:string|null;rails?:Record<string,CashoutRail>;selection?:{selected?:string|null;rail?:CashoutRail;error?:string;code?:string}|null};

// Read-only Coinbase cash-out rail discovery. Nothing here moves money — the
// payout itself is OWNER LIVE VERIFY REQUIRED.
function CashoutRails(): JSX.Element {
  const [state,setState]=useState<CashoutState|null>(null);
  const [busy,setBusy]=useState(false);
  async function load() {
    if(busy)return; setBusy(true);
    try {
      const response=await fetch("/kayjay/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"cashout_rails",input:{instantOnly:true}}),signal:AbortSignal.timeout(12000)});
      setState(await response.json() as CashoutState);
    } catch { setState({error:"Coinbase cash-out discovery is unavailable. No rail is confirmed."}); }
    finally { setBusy(false); }
  }
  const order=["instantCard","rtp","paypal","cdpOfframp"];
  return <details><summary>Cash out · Coinbase rails{state?.selection?.selected?` · best: ${state.selection.selected}`:""}</summary>
    <p>Coinbase is the only cash-out provider. Rails are discovered from your real Coinbase payment methods; a payout is an owner action.</p>
    <button disabled={busy} onClick={()=>void load()}>{busy?"Checking…":"Discover rails"}</button>
    {state?.error&&<p role="alert">{state.error}</p>}
    {state&&!state.error&&<>
      <p>Coinbase auth: {state.authenticated?"authenticated":"not authenticated"}{state.country?` · ${state.country}`:""}</p>
      <table style={{width:"100%"}}><thead><tr><th>Rail</th><th>Eligible</th><th>Detail</th></tr></thead>
        <tbody>{order.map(key=>{const r=state.rails?.[key];return <tr key={key}><td>{r?.label??key}</td><td>{r?.candidate?"Yes":"No"}</td><td>{r?.reason??"Unknown"}</td></tr>;})}</tbody></table>
      {state.selection?.error?<p role="alert">{state.selection.error}</p>:state.selection?.selected&&<p>Selected instant rail: <strong>{state.selection.selected}</strong> — a payout requires owner confirmation (OWNER LIVE VERIFY REQUIRED).</p>}
    </>}
  </details>;
}

// Coinbase Onramp / Apple Pay sandbox funding. Coinbase is the sole payment
// provider. Cash-out (Coinbase off-ramp rails) is a separate control.
function SandboxPayments(): JSX.Element {
  const [amount,setAmount]=useState("");
  const [destination,setDestination]=useState("");
  const [network,setNetwork]=useState("base");
  const [result,setResult]=useState<PaymentResult|null>(null);
  const [quotedDetails,setQuotedDetails]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [lastIntent,setLastIntent]=useState("");
  const [unknown,setUnknown]=useState(false);
  const [started,setStarted]=useState(false);
  const [confirmed,setConfirmed]=useState(false);
  const details=JSON.stringify({amount,destination,network});
  const quoted=quotedDetails===details;
  const prefix="kayjay-fund";

  async function request(action:string,input:Record<string,unknown>,confirm=false,existingIntent="") {
    if(busy)return;
    setBusy(true);setMessage("Waiting for the provider…");
    let intentId=existingIntent;
    const mutates=action==="fund_start";
    try {
      if(mutates){
        // Stable per details, across refreshes/tabs. A timeout never creates a new request ID.
        const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({action,input})));
        intentId="face_"+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
        setLastIntent(intentId);
        const saved=localStorage.getItem(prefix+":"+intentId);
        if(saved==="unknown"||saved==="pending"){
          setUnknown(true);setMessage("This request may already have reached the provider. Use Check previous request before another attempt.");return;
        }
        localStorage.setItem(prefix+":"+intentId,"pending");
      }
      const response=await fetch("/kayjay/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,input,intentId,confirm}),signal:AbortSignal.timeout(18000)});
      const data=await response.json() as PaymentResult;
      if(!response.ok||data.error){
        const uncertain=!["coinbase_auth_required","coinbase_auth_failed","wallet_required","invalid_amount","sandbox_required","network_required","asset_required","currency_required","confirmation_required","invalid_id","state_busy","state_unavailable","unsupported_action"].includes(data.code??"");
        if(mutates)localStorage.setItem(prefix+":"+intentId,uncertain?"unknown":"ready");
        setUnknown(uncertain&&mutates);setMessage(data.error??"Provider request was rejected. No successful payment is confirmed.");return;
      }
      if(mutates)localStorage.setItem(prefix+":"+intentId,"received");
      setResult(data);setUnknown(data.state==="unknown");
      if(action==="fund_quote"){setQuotedDetails(details);setConfirmed(false);setStarted(false);}
      if(action==="fund_start")setStarted(true);
      setMessage(data.message??(data.paymentUrl?"Sandbox checkout is ready. Open Apple Pay using the link below.":"Provider response received. See its status below; a quote is not a completed payment."));
    } catch {
      if(mutates){try{localStorage.setItem(prefix+":"+intentId,"unknown");}catch{/* Preserve the visible unknown outcome. */}}
      setUnknown(mutates);setMessage(mutates?"Response unavailable. The outcome is unknown; do not submit another payment. Check the previous request.":"Provider status unavailable. No successful payment is confirmed.");
    } finally {setBusy(false);}
  }
  async function fundingInput() {
    let owner=localStorage.getItem("kayjay-payment-owner");
    if(!owner){owner="sandbox-"+crypto.randomUUID();localStorage.setItem("kayjay-payment-owner",owner);}
    return {destinationAddress:destination,destinationNetwork:network,partnerUserRef:owner,purchaseCurrency:"USDC",paymentCurrency:"USD",paymentAmount:amount};
  }
  async function fund(action:string,confirm=false){
    try{await request(action,await fundingInput(),confirm);}catch{setMessage("Local payment state is unavailable. Enable local storage before starting a sandbox request.");}
  }
  const paymentLink=(()=>{try{const url=new URL(result?.paymentUrl??"");return url.origin==="https://pay.coinbase.com"&&!url.username&&!url.password&&url.searchParams.get("useApplePaySandbox")==="true"?url.href:null;}catch{return null;}})();
  const fieldStyle={display:"block",margin:"8px 0"};
  return <details><summary>Fund · Apple Pay · SANDBOX</summary>
    <p>Test USDC funding through Coinbase Apple Pay. Sandbox checkout does not charge a card or add real funds.</p>
    <p>Requires Coinbase CDP Onramp authorization and a destination wallet. Live Apple Pay also requires provider approval, domain verification, and user verification.</p>
    <fieldset disabled={busy} style={{border:0,padding:0}}>
      <label style={fieldStyle}>Amount (USD) <input aria-label="Fund amount USD" inputMode="decimal" value={amount} onChange={event=>{setAmount(event.target.value);setConfirmed(false);}} placeholder="0.00"/></label>
      <label style={fieldStyle}>Destination wallet <input style={{width:"100%",boxSizing:"border-box"}} value={destination} onChange={event=>{setDestination(event.target.value.trim());setConfirmed(false);}} autoComplete="off" spellCheck={false}/></label>
      <label style={fieldStyle}>Network <select value={network} onChange={event=>{setNetwork(event.target.value);setConfirmed(false);}}><option value="base">Base</option><option value="ethereum">Ethereum</option><option value="solana">Solana</option></select></label>
      <p>Asset: USDC</p>
      <button disabled={!amount||!destination} onClick={()=>{setResult(null);setStarted(false);setConfirmed(false);void fund("fund_quote");}}>Get sandbox quote</button>
      {result&&quoted&&<>
        <p>Provider status: {result.order?.status??"Quote received"}</p>
        {result.order&&<p>Total: {result.order.paymentTotal??"Unavailable"} {result.order.paymentCurrency??"USD"} · Receive: {result.order.purchaseAmount??"Unavailable"} {result.order.purchaseCurrency??"USDC"}</p>}
        {result.order?.fees&&<p>Quoted fees: {result.order.fees.map((fee,index)=><span key={index}>{index?" + ":""}{fee.amount??"Unavailable"} {fee.currency??""}</span>)}</p>}
        {!started&&!unknown&&<><label style={fieldStyle}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> I confirm these sandbox details for Apple Pay checkout.</label>
          <button disabled={!confirmed} onClick={()=>void fund("fund_start",true)}>Start Apple Pay sandbox</button></>}
        {paymentLink&&<p><a href={paymentLink} target="_blank" rel="noopener noreferrer">Open Apple Pay sandbox checkout</a></p>}
        {result.order?.orderId&&<button onClick={()=>void request("fund_status",{orderId:result.order?.orderId})}>Check funding status</button>}
      </>}
      {lastIntent&&<button style={{marginLeft:8}} onClick={()=>void request("reconcile",{},false,lastIntent)}>Check previous request</button>}
    </fieldset>
    {message&&<p role={unknown?"alert":"status"}>{message}</p>}
    {unknown&&<p>Automatic retries are disabled. A missing response does not mean the provider rejected the request.</p>}
  </details>;
}

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
  const [coinbaseAccount,setCoinbaseAccount]=useState<CoinbaseSnapshot|null>(null);
  const [coinbaseError,setCoinbaseError]=useState(false);
  const [portfolioError,setPortfolioError]=useState(false);
  useEffect(()=>{
    if(tab!=="Accounts")return;
    const controller=new AbortController();
    let active=true;
    let coinbaseBusy=false;
    const pollCoinbase=async()=>{
      if(coinbaseBusy)return;
      coinbaseBusy=true;
      try{
        const response=await fetch("/kayjay/coinbase",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(35000)])});
        if(!response.ok)throw new Error("Unavailable");
        const data=await response.json() as CoinbaseSnapshot;
        if(!data||typeof data.state!=="string")throw new Error("Invalid account response");
        if(active){setCoinbaseAccount(data);setCoinbaseError(false);}
      }catch{if(active)setCoinbaseError(true);}finally{coinbaseBusy=false;}
    };
    let portfolioBusy=false;
    const poll=async()=>{
      if(portfolioBusy)return;
      portfolioBusy=true;
      try{
      const response=await fetch("/kayjay/portfolio",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(35000)])});
      if(!response.ok)throw new Error("Unavailable");
      const data=await response.json();
      if(active){setPortfolio(data);setPortfolioError(false);}
    }catch{if(active)setPortfolioError(true);}finally{portfolioBusy=false;}};
    void poll();void pollCoinbase();const timer=setInterval(()=>{void poll();void pollCoinbase();},30000);
    return()=>{active=false;clearInterval(timer);controller.abort();};
  },[tab]);
  useEffect(()=>{
    const navigate=(event:Event)=>{const name=(event as CustomEvent<string>).detail;setTab(config.settings["view"]==="nav"?name:name==="Dashboard"||name==="Markets"||name==="Meme Coins"?"Health":name==="Brokers"?"Accounts":name);};
    window.addEventListener("kayjay-section",navigate);return()=>window.removeEventListener("kayjay-section",navigate);
  },[]);
  const [liveData,setLiveData]=useState<{complete:boolean;sources:{engine:string;available:boolean;state:string;data:unknown}[]}|null>(null);
  const [liveDataError,setLiveDataError]=useState(false);
  useEffect(()=>{if(!["Positions","Orders"].includes(tab))return;let active=true;const poll=async()=>{try{const response=await fetch("/kayjay/data",{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();const data=await response.json();if(active){setLiveData(data);setLiveDataError(false);}}catch{if(active)setLiveDataError(true);}};void poll();const timer=setInterval(()=>void poll(),10000);return()=>{active=false;clearInterval(timer);};},[tab]);
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
      <h3>Connections</h3><div className="kayjay-connections">{["Bluelights","Robinhood","Webull","OANDA","Kalshi","Coinbase"].map(name=>{
       const service=snapshot.services.find(s=>s.name===name);const state=error?"STALE":service?.state??"UNVERIFIED";
       return <div key={name} title={"Authentication: "+(service?.authenticated===true?"verified":service?.authenticated===false?"failed":"unverified")+" | Readiness: "+(service?.ready===true?"ready":service?.ready===false?"not ready":"unverified")+" | Last successful check: "+(service?.lastSuccess??"none")}><span>{name}</span><b className={state==="CONNECTED"?"positive":"negative"}>{state}</b><small>{service?.ms!=null?service.ms+" ms":"Readiness unavailable"}</small></div>;
      })}</div>
      <div className="kayjay-position-summary"><button onClick={()=>setTab("Positions")}>Positions · {snapshot.services.find(s=>s.name==="Positions")?.state==="CONNECTED"?"View live":"Unavailable"}</button><button onClick={()=>setTab("Orders")}>Orders · {snapshot.services.find(s=>s.name==="Orders")?.state==="CONNECTED"?"View live":"Unavailable"}</button></div>
      <p className="kayjay-help">Execution controls remain with each engine. Offline is not the same as mode OFF. No global P&amp;L is inferred from practice balances.</p>
      <small>Last health check {new Date(snapshot.updatedAt).toLocaleTimeString()}</small>
    </>}
    {tab==="Settings" && <p>Use Settings in the top bar for the existing eTape settings. Engine authority is controlled in its own system view.</p>}
    {tab==="Accounts" && <>
      <SandboxPayments/>
      <CashoutRails/>
      <CoinbaseTrading/>
      <details><summary>Coinbase account · {coinbaseError?"STALE / UNAVAILABLE":coinbaseAccount?.state??"Checking"}</summary>
        <p>Read only · Refreshes every 30 seconds while Accounts is open.</p>
        {coinbaseError&&<p role="alert">Coinbase refresh failed. Retained data is stale; account readiness is unknown.</p>}
        {!coinbaseAccount&&!coinbaseError&&<p>Reading Coinbase account data…</p>}
        {coinbaseAccount&&<>
          <p>Authentication: {coinbaseAccount.authenticated===true?"Verified":coinbaseAccount.authenticated===false?"Not verified":"Unknown"} · Account readiness: {coinbaseError?"Unknown":coinbaseAccount.ready===true?"Ready":coinbaseAccount.ready===false?"Not ready":"Unknown"} · Coverage: {coinbaseAccount.complete===true?"Complete":"Incomplete"}</p>
          {coinbaseAccount.reason&&<p>{coinbaseAccount.reason}</p>}
          <h4>Balances{coinbaseAccount.accountsComplete!==true&&" · Incomplete"}</h4>
          {coinbaseAccount.accounts==null?<p>Unavailable</p>:coinbaseAccount.accounts.length===0?<p>No accounts returned{coinbaseAccount.accountsComplete!==true&&"; coverage incomplete"}.</p>:
            <table style={{width:"100%"}}><thead><tr><th>Currency</th><th>Available</th><th>Held</th></tr></thead><tbody>{coinbaseAccount.accounts.map((account,index)=><tr key={index}><td>{coinbaseValue(account.currency)}</td><td>{coinbaseValue(account.available)}</td><td>{coinbaseValue(account.held)}</td></tr>)}</tbody></table>}
          <CoinbaseOrders label="Open orders" orders={coinbaseAccount.orders} complete={coinbaseAccount.ordersComplete}/>
          <h4>Fills{coinbaseAccount.fillsComplete!==true&&" · Incomplete"}</h4>
          {coinbaseAccount.fills==null?<p>Unavailable</p>:coinbaseAccount.fills.length===0?<p>No fills returned{coinbaseAccount.fillsComplete!==true&&"; coverage incomplete"}.</p>:
            <table style={{width:"100%"}}><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Price</th><th>Time</th></tr></thead><tbody>{coinbaseAccount.fills.map((fill,index)=><tr key={fill.id??index}><td>{coinbaseValue(fill.symbol)}</td><td>{coinbaseValue(fill.side)}</td><td>{coinbaseValue(fill.size)}</td><td>{coinbaseValue(fill.price)}</td><td>{fill.time?new Date(fill.time).toLocaleString():"Unavailable"}</td></tr>)}</tbody></table>}
          <CoinbaseOrders label="Trade / order history" orders={coinbaseAccount.history} complete={coinbaseAccount.historyComplete}/>
          <p>Received {coinbaseAccount.asOf?new Date(coinbaseAccount.asOf).toLocaleString():"time unavailable"}. Balances use each account’s currency; prices use the market’s quote currency.</p>
        </>}
      </details>
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
    {["Positions","Orders"].includes(tab) && <>
      {liveDataError&&<p role="alert">State refresh failed; retained data is stale.</p>}
      {!liveData&&!liveDataError&&<p>Reading existing engine accounts...</p>}
      {liveData?.sources.filter(s=>tab==="Positions"?s.engine.includes("positions")||s.engine.includes("P&L"):s.engine.includes("orders")).map(s=><section key={s.engine}><h3>{s.engine} · {s.available?"Received":s.state}</h3><pre style={{whiteSpace:"pre-wrap"}}>{s.available?JSON.stringify(s.data,null,2):"Unavailable. This is not an empty account or a zero balance."}</pre></section>)}
      <p>Coverage: JINX and ATLAS responses shown separately. RAPTOR15 and unconnected venue accounts are not included in a global total.</p>
    </>}
  </div>;
}
