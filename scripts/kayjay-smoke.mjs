import assert from "node:assert/strict";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(path.join(root,"ui/package.json"));
const {chromium}=require("@playwright/test");
const browser=await chromium.launch({channel:"chrome",headless:true});
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:8687/?workspace=kayjay");
 await page.getByRole("button",{name:"Health",exact:true}).waitFor({timeout:30000});
 await page.getByText("Bluelights",{exact:true}).waitFor();
 await page.locator(".kayjay-book tbody tr").first().waitFor();
 for (const symbol of ["ETH","SOL","BTC"]) {
   await page.locator(".kayjay-coin").filter({has:page.getByAltText(symbol+" logo")}).click();
   await page.waitForFunction(s=>document.querySelector(".kayjay-book tbody tr") && [...document.querySelectorAll(".kayjay-market-toolbar strong")].every(e=>e.textContent.startsWith(s)),symbol);
 }
 assert.equal(await page.locator(".kayjay-coin img").evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth>0)),true);
 assert.equal(await page.locator(".kayjay-live-chart").isVisible(),true);
 assert.equal(await page.locator(".kayjay-live-chart").evaluate(e=>e.clientWidth>800&&e.clientHeight>200),true);
 await page.screenshot({path:path.join(root,"dist/kayjay.png"),fullPage:true});
 await page.setViewportSize({width:1366,height:768});
 await page.waitForTimeout(500);
 assert.equal(await page.locator(".kayjay-live-chart").isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.screenshot({path:path.join(root,"dist/kayjay-1366.png"),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log("PASS: live BTC/ETH/SOL switching, loaded coin artwork, visible chart, 1920 and 1366 viewport checks; no page errors.");
} finally {await browser.close();}
