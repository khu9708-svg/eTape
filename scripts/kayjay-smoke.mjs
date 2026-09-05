import assert from "node:assert/strict";
import {createRequire} from "node:module";import path from "node:path";import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const require=createRequire(path.join(root,"ui/package.json"));const {chromium}=require("@playwright/test");
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:8687/?workspace=kayjay");await page.getByRole("button",{name:"Health",exact:true}).waitFor({timeout:30000});
 await page.locator(".kayjay-connections").waitFor();await page.locator(".kayjay-tv iframe").waitFor({timeout:30000});
 await page.waitForTimeout(5000);
 await page.screenshot({path:path.join(root,"dist/kayjay.png"),fullPage:true});
 assert.equal(await page.locator(".kayjay-engine-cards article").count(),3);
 assert.equal(await page.locator(".kayjay-connections>div").count(),6);
 await page.getByRole("button",{name:"Native chart",exact:true}).click();
 for(const symbol of ["ETH","SOL","BTC"]){await page.locator(".kayjay-coin").filter({has:page.getByAltText(symbol+" logo")}).click();await page.waitForFunction(s=>document.querySelector(".kayjay-market-toolbar strong")?.textContent.startsWith(s),symbol);}
 assert.equal(await page.locator(".kayjay-live-chart").isVisible(),true);
 await page.getByRole("navigation").getByRole("button",{name:"Meme Coins",exact:true}).click();
 await page.locator(".kayjay-token-results tbody tr").first().waitFor({timeout:30000});
 await page.getByRole("textbox",{name:"Token name, symbol or contract"}).fill("BONK");await page.getByRole("button",{name:"Search tokens"}).click();
 await page.waitForResponse(r=>r.url().includes("/kayjay/discovery?feed=search")&&r.status()===200);
 await page.locator(".kayjay-token-results tbody tr button").first().click();
 await page.getByLabel("Selected token chart").waitFor(); await page.getByText(/Live 15m candles/).waitFor({timeout:20000});
 await page.waitForTimeout(5000);await page.screenshot({path:path.join(root,"dist/kayjay-discovery.png"),fullPage:true});
 await page.getByRole("navigation").getByRole("button",{name:"Dashboard",exact:true}).click();
 await page.setViewportSize({width:1366,height:768});await page.waitForTimeout(500);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(root,"dist/kayjay-1366.png"),fullPage:true});
 assert.deepEqual(errors,[]);console.log("PASS: black cockpit, three engine cards, six connectivity states, TradingView embed, native coin switching, live BONK search and token chart, responsive viewport; no page errors.");
}finally{await browser.close();}
