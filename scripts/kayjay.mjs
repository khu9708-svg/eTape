import {marketSnapshot} from "./kayjay-market.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "ui/package.json"));
const { WebSocket, WebSocketServer } = require("ws");
const port = 8687;
const origin = `http://127.0.0.1:${port}`;
const projects = path.resolve(root, "../..");
let raptor = { state: "WAITING", text: "Waiting for the existing RAPTOR15 live reader.", updatedAt: null };
let raptorBusy = false;
export function allowCommand(message, demo) {
  if (message.kind !== "command") return ["subscribe", "unsubscribe", "ping", "query"].includes(message.kind);
  if (["ReturnToLive", "StartLive", "StopDemo", "StartReplay", "StopReplay"].includes(message.name)) return false;
  if (["SetConfig", "GetConfig", "SetAccountDemand", "FocusGroup", "EnsureSymbol", "ReleaseSymbol", "StartDemo"].includes(message.name)) return true;
  return demo && ["SubmitOrder", "CancelOrder", "ReplaceOrder", "Flatten", "Arm", "Disarm", "KillSwitch"].includes(message.name);
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k,
      /secret|token|password|api.?key|authorization|private.?key/i.test(k) ? (v ? "SET" : "UNSET") : redact(v)]));
  return value;
}
async function probe(name, url, auth = false) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3500),
      headers: auth && process.env.MCP_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN}` } : {} });
    if (!response.ok) return { name, state: response.status === 401 ? "AUTH REQUIRED" : "UNAVAILABLE", ms: Date.now()-started, data: null };
    const data = redact(await response.json());
    return { name, state: name === "Robinhood" && !data.connected ? "LOGIN REQUIRED" : "CONNECTED", ms: Date.now()-started, data };
  } catch { return { name, state: "OFFLINE", ms: null, data: null }; }
}
async function readRaptor() {
  if (raptorBusy) return;
  raptorBusy = true;
  const child = spawn(process.env.KAYJAY_PYTHON || "python", ["-u", "-m", "raptor15.cli", "live", "BTC", "ETH"], {
    cwd: path.join(projects, "RAPTOR15"), windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const timer = setTimeout(() => child.kill(), 90000);
  child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-16000); });
  child.stderr.on("data", () => {});
  child.on("error", () => { raptor = { state: "UNAVAILABLE", text: "Existing RAPTOR15 reader could not start.", updatedAt: new Date().toISOString() }; });
  child.on("close", code => {
    clearTimeout(timer); raptorBusy = false;
    raptor = { state: code === 0 ? "READ ONLY" : "UNAVAILABLE",
      text: output || "RAPTOR15 could not retrieve a live window. No orders were placed.",
      updatedAt: new Date().toISOString() };
  });
}
export function createCockpitServer() {
  const server = http.createServer(async (req,res) => {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); return res.end("Local cockpit only");
    }
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, origin);
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/kayjay/markets") {
      res.setHeader("Content-Type","application/json");
      try { return res.end(JSON.stringify(await marketSnapshot(url.searchParams.get("symbol") || "BTC",Number(url.searchParams.get("seconds") || 60)))); }
      catch { res.writeHead(502); return res.end(JSON.stringify({error:"Market source unavailable"})); }
    }
    if (url.pathname === "/kayjay/status") {
      const services = await Promise.all([
        probe("Bluelights", "http://127.0.0.1:8787/health", true),
        probe("JINX", "http://127.0.0.1:8794/status"),
        probe("ATLAS", "http://127.0.0.1:8080/api/execution-mode"),
        probe("Brokers", "http://127.0.0.1:8080/api/broker-readiness"),
        probe("Positions", "http://127.0.0.1:8080/api/positions"),
        probe("Orders", "http://127.0.0.1:8080/api/orders/open"),
        probe("Chrome", "http://127.0.0.1:9222/json/version"),
        probe("Robinhood", "http://127.0.0.1:8765/health")
      ]);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ name:"KAYJAY", updatedAt: new Date().toISOString(), services, raptor }));
    }
    try {
      const requested = decodeURIComponent(url.pathname);
      const base = path.join(root, "ui/dist");
      const target = path.resolve(base, "." + (requested === "/" ? "/index.html" : requested));
      if (!target.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
      const data = await fs.readFile(target);
      const mime = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".woff2":"font/woff2", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json" };
      res.setHeader("Content-Type", mime[path.extname(target)] || "application/octet-stream");
      res.end(data);
    } catch { res.writeHead(404); res.end("Not found"); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2*1024*1024 });
  server.on("upgrade", (req,socket,head) => {
    if (req.url !== "/ws" || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== origin) return socket.destroy();
    wss.handleUpgrade(req,socket,head, client => {
      const upstream = new WebSocket("ws://127.0.0.1:8686/ws", { origin: "http://127.0.0.1:8686" });
      let demo = false;
      const pending = [];
      upstream.on("open", () => {
        upstream.send(JSON.stringify({kind:"subscribe",topic:"sys.session"}));
        for (const message of pending) upstream.send(message);
      });
      upstream.on("message", bytes => {
        const raw = bytes.toString();
        try {
          const m = JSON.parse(raw);
          if (m.topic === "sys.session") demo = (m.data?.mode ?? m.payload?.mode) === "demo";
        } catch {}
        if (client.readyState === WebSocket.OPEN) client.send(raw);
      });
      client.on("message", bytes => {
        try {
          const m = JSON.parse(bytes.toString());
          if (!allowCommand(m, demo)) {
            client.send(JSON.stringify({kind:"ack",corrId:m.corrId,status:"blocked",reason:"KAYJAY: live orders use the existing engine risk and mode controls. eTape is practice only."}));
            return;
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString());
          else if (pending.length < 200) pending.push(bytes.toString());
        } catch { client.close(1003); }
      });
      upstream.on("error", () => client.close(1011));
      upstream.on("close", () => client.close());
      client.on("close", () => upstream.close());
    });
  });
  server.on("close", () => wss.close());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createCockpitServer().listen(port,"127.0.0.1", () => {
    console.log(`KAYJAY listening at ${origin}`);
    void fetch("http://127.0.0.1:8765/connect", { method: "POST", signal: AbortSignal.timeout(90000) }).catch(() => {});
    void readRaptor();
    setInterval(() => void readRaptor(), 60000).unref();
  });
}
