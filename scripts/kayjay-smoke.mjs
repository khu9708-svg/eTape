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
 await page.waitForTimeout(5000);
 console.log((await page.locator("body").innerText()).slice(0,18000));
 console.log("PAGE_ERRORS="+JSON.stringify(errors));
 await page.screenshot({path:path.join(root,"dist/kayjay.png"),fullPage:true});
 if(errors.length) process.exitCode=1;
} finally {await browser.close();}
