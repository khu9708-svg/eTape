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
  const atlas = snapshot?.services.find(s => s.name === "ATLAS");
  const jinx = snapshot?.services.find(s => s.name === "JINX");
  return <div style={{height:"100%",overflow:"auto",padding:12,color:palette.text,fontSize:12}}>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
      {["Health","JINX","ATLAS","RAPTOR15","Positions","Orders"].map(name =>
        <button key={name} onClick={() => setTab(name)} aria-pressed={tab===name}>{name}</button>)}
    </div>
    <p style={{color:palette.textMuted}}>KAYJAY · Existing engine controls · eTape charts and tickets are practice data</p>
    {error && <p role="alert" style={{color:palette.danger}}>Connection lost. Last received data is stale; trading readiness is unknown.</p>}
    {!snapshot && !error && <p>Connecting to the existing services…</p>}
    {snapshot && tab==="Health" && <>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr><th style={{textAlign:"left"}}>System</th><th>State</th><th>Latency</th></tr></thead>
        <tbody>{snapshot.services.filter(s=>!["Positions","Orders","Brokers"].includes(s.name)).map(s =>
          <tr key={s.name}><td style={{padding:"7px 0"}}>{s.name}</td><td style={{color:error?palette.danger:s.state==="CONNECTED"?palette.ok:palette.warn}}>
            {error ? "STALE" : s.name==="ATLAS" && s.data?.["mode"] ? String(s.data["mode"]) : s.state}
          </td><td>{s.ms===null?"—":`${s.ms} ms`}</td></tr>)}
          <tr><td>RAPTOR15</td><td>{error?"STALE":snapshot.raptor.state}</td><td>Read only</td></tr>
        </tbody>
      </table>
      <p>Robinhood · Webull · OANDA · Kalshi</p>
      <p style={{color:palette.textMuted}}>Webull and OANDA use ATLAS readiness and its existing approval flow. Kalshi feeds use RAPTOR15. Robinhood order routing is not connected.</p>
      <details><summary>Broker readiness</summary><pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(snapshot.services.find(s=>s.name==="Brokers")?.data ?? {state:"ATLAS offline; broker readiness unknown"},null,2)}</pre></details>
      <p style={{color:palette.textMuted}}>Received {new Date(snapshot.updatedAt).toLocaleTimeString()}</p>
    </>}
    {tab==="ATLAS" && <>
      {atlas?.state==="CONNECTED" && !error
        ? <iframe title="ATLAS existing execution cockpit" src="http://127.0.0.1:8080/" style={{width:"100%",height:"85%",minHeight:450,border:0}} />
        : <p>ATLAS is offline. Its existing dashboard and OFF / MANUAL / AUTO authority will appear here when running. The launcher does not enable a disabled engine.</p>}
    </>}
    {tab==="JINX" && <><p>Existing JINX worker · {error?"STALE":jinx?.state ?? "CONNECTING"}</p>
      <pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(jinx?.data ?? {state:"Worker offline; execution authority unchanged"},null,2)}</pre></>}
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
