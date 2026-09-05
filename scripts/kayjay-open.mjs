// Reuse the existing Bluelights Chrome/CDP workstation window.
const timeout=setTimeout(()=>{console.error("Chrome/CDP did not respond");process.exit(1);},10000);
const info=await (await fetch("http://127.0.0.1:9222/json/version")).json();
const socket=new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let nextId=0;
const pending=new Map();
socket.onmessage=event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
try {
 const url="http://127.0.0.1:8687/?workspace=kayjay";
 const {targetInfos}=await call("Target.getTargets");
 let targetId=targetInfos.find(t=>t.type==="page"&&t.url===url)?.targetId;
 if(!targetId)({targetId}=await call("Target.createTarget",{url,newWindow:true}));
 const {windowId,bounds}=await call("Browser.getWindowForTarget",{targetId});
 if(bounds.windowState==="minimized") await call("Browser.setWindowBounds",{windowId,bounds:{windowState:"normal"}});
 await call("Browser.setWindowBounds",{windowId,bounds:{windowState:"fullscreen"}});
 const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
 await call("Page.reload",{ignoreCache:true},sessionId);
 await call("Target.activateTarget",{targetId});
 console.log("KAYJAY fullscreen window ready.");
} finally {socket.close();clearTimeout(timeout);}
