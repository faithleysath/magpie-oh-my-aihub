// Final installed-source/user-visible history check. Product actions only through UI.
import { webkit, type Page } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const runtime=JSON.parse(readFileSync(process.argv[2]!,"utf8"));
const wanted=process.argv[3]!;if(!/^[a-f0-9]{7,40}$/.test(wanted))throw new Error("expected commit required");
const out=resolve(process.argv[4]??"../docs/validation/phase9-browser");mkdirSync(out,{recursive:true});
const b=await webkit.launch({headless:true}),ctx=await b.newContext({viewport:{width:1440,height:1000}});
const steps:{name:string;ok:boolean}[]=[];let phase="start";
const pass=(name:string)=>{steps.push({name,ok:true});console.log("PASS "+name);};
async function login(p:Page,url:string){await p.goto(url);const n=p.getByRole("dialog",{name:/What's new/});if(await n.isVisible())await n.getByRole("button",{name:"Close",exact:true}).click();}
try{
 for(const name of ["consumer","provider2"]){
  phase=name+" GUI update";const p=await ctx.newPage();await login(p,runtime.nodes[name].webLoginUrl);
  await p.getByRole("button",{name:"Plugins",exact:true}).click();await p.getByRole("tab",{name:/Installed/}).click();
  await p.getByRole("button",{name:"Check for updates",exact:true}).click();
  const update=p.getByRole("button",{name:"Update",exact:true});
  await Promise.race([update.waitFor({timeout:30000}),p.getByText(wanted.slice(0,7),{exact:true}).waitFor({timeout:30000})]);
  if(await update.isVisible())await update.click();
  await p.getByText(wanted.slice(0,7),{exact:true}).waitFor({timeout:60000});pass(name+" GitHub plugin updated through Magpie GUI to "+wanted.slice(0,7));await p.close();
 }
 phase="provider pairing";const m=await ctx.newPage();await login(m,runtime.nodes.provider.webLoginUrl);await m.getByRole("button",{name:"Oh My AIHub",exact:true}).click();const frame=m.frameLocator("iframe");
 await frame.locator("#console-origin").filter({hasText:/^http:/}).waitFor({timeout:30000});const origin=(await frame.locator("#console-origin").innerText()).trim();const p=await ctx.newPage();await p.goto(origin+"/");await p.locator("#pair-browser").click();await p.locator("#pairing-code").filter({hasText:/\d{4}\s?\d{4}/}).waitFor();const code=(await p.locator("#pairing-code").innerText()).replace(/\s/g,"");
 for(let i=0;i<6;i++){await frame.getByRole("button",{name:"刷新状态",exact:true}).click();try{await frame.locator(".pairing-code").filter({hasText:code}).waitFor({timeout:1500});break;}catch{if(i===5)throw new Error("pairing absent");}}
 const row=frame.locator(".pairing-request").filter({hasText:code});await row.getByRole("checkbox").check();await row.getByRole("button",{name:"批准此浏览器",exact:true}).click();await p.getByText("本机已连接",{exact:true}).waitFor({timeout:45000});pass("final provider build authorized through explicit native pairing");
 const req=JSON.parse(readFileSync(runtime.root+"/connection-request.json","utf8"));
 await p.locator("#nav-accounting").click();await p.getByLabel("伙伴账目",{exact:true}).selectOption(req.consumer.nodeId);await p.getByRole("button",{name:"核验此伙伴账目与额度",exact:true}).click();await p.locator("#notice").filter({hasText:"操作已返回"}).waitFor();
 phase="immutable consumption history";await p.getByRole("button",{name:"查看消费记录",exact:true}).click();const dialog=p.locator("dialog[open]");await dialog.getByRole("heading",{name:"消费记录",exact:true}).waitFor();await dialog.locator("details summary").first().waitFor();await dialog.locator("details summary").first().click();await dialog.getByText("provider/provider-model",{exact:true}).first().waitFor();const history=await dialog.innerText();
 if(!history.includes("价格")||!history.includes("窗口"))throw new Error("history missing frozen metadata");
 await p.screenshot({path:out+"/final-consumption-history.png"});pass("selected-consumer immutable usage records rendered with price/window/token evidence");await dialog.getByRole("button",{name:"关闭",exact:true}).click();
 phase="actual browser security refusal";
 // Negative HTTP checks are verification only; none can reach a business handler.
 const security=await p.evaluate(async()=>{
   const script=await(await fetch('/session.js')).text();const requestHeader=script.match(/["'](X-[^"']+-Request)["']/)?.[1];if(!requestHeader)throw new Error('request header unavailable');
   const denied=await fetch('/ui/api/action/checks',{method:'POST',headers:{'Content-Type':'application/json',[requestHeader]:'1','Idempotency-Key':crypto.randomUUID()},body:'{}'});
   const unknown=await fetch('/ui/api/not-an-api',{headers:{[requestHeader]:'1'}});
   return{missingCsrf:denied.status,unknownApi:unknown.status,jsCookies:document.cookie,localStorageKeys:Object.keys(localStorage),sessionStorageKeys:Object.keys(sessionStorage)};
 });
 if(security.missingCsrf!==403||security.unknownApi!==404||security.jsCookies.includes("ohmyaihub_ui_")||security.localStorageKeys.length||security.sessionStorageKeys.length)throw new Error("browser security refusal failed");pass("actual WebKit rejects CSRF/unknown API and exposes no JS cookie or persistent app storage");
 await p.getByRole("button",{name:"退出会话",exact:true}).click();await p.reload();await p.locator("#pair-browser").waitFor();pass("final logout requires fresh authorization");
 writeFileSync(out+"/final-installed-ui.json",JSON.stringify({at:new Date().toISOString(),engine:"WebKit",version:b.version(),expectedCommit:wanted,steps,security:{missingCsrf:403,unknownApi:404,persistentAppStorage:false},pass:true},null,2));
}catch(e){writeFileSync(out+"/final-installed-ui-failure.json",JSON.stringify({at:new Date().toISOString(),phase,errorKind:e instanceof Error?e.name:"Unknown",steps,pass:false},null,2));throw new Error("final UI acceptance failed at "+phase);}
finally{await ctx.close();await b.close();}
