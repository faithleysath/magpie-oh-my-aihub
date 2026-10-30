// Actual WebKit UI journey: second provider + existing consumer. No business API/CLI calls.
import { webkit, type Page } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const runtimePath=process.argv[2];
if(!runtimePath||!/^(\/private)?\/tmp\//.test(runtimePath))throw new Error("isolated runtime required");
const runtime=JSON.parse(readFileSync(runtimePath,"utf8")),provider=runtime.nodes.provider2,consumer=runtime.nodes.consumer;
const out=resolve(process.argv[3]??"../docs/validation/phase9-browser"),privateDir=join(runtime.root,"webkit-sharing");
mkdirSync(out,{recursive:true});mkdirSync(privateDir,{recursive:true,mode:0o700});
const browser=await webkit.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
const steps:{name:string;ok:boolean}[]=[];const pass=(name:string)=>{steps.push({name,ok:true});console.log(`PASS ${name}`);};
async function pair(native:Page,origin:string){
  const page=await context.newPage();await page.goto(origin+"/");await page.locator("#pair-browser").click();
  await page.locator("#pairing-code").filter({hasText:/\d{4}\s?\d{4}/}).waitFor();
  const code=(await page.locator("#pairing-code").innerText()).replace(/\s/g,"");const frame=native.frameLocator("iframe");
  let found=false;for(let i=0;i<5;i++){await frame.getByRole("button",{name:"刷新状态",exact:true}).click();try{await frame.locator(".pairing-code").filter({hasText:code}).waitFor({timeout:1500});found=true;break;}catch{}}
  if(!found)throw new Error("matching pairing code absent");const row=frame.locator(".pairing-request").filter({hasText:code});await row.getByRole("checkbox").check();await row.getByRole("button",{name:"批准此浏览器",exact:true}).click();await page.getByText("本机已连接",{exact:true}).waitFor({timeout:30000});return page;
}
async function confirm(page:Page,title:string){const dialog=page.locator("dialog[open]");await dialog.getByRole("checkbox").check();await dialog.getByRole("button",{name:title,exact:true}).click();await dialog.waitFor({state:"hidden",timeout:30000});}
async function importFile(page:Page,button:string,file:string,submit:string){await page.getByRole("button",{name:button,exact:true}).click();const dialog=page.locator("dialog[open]");await dialog.locator('input[type="file"]').setInputFiles(file);await dialog.getByRole("checkbox").check();await dialog.getByRole("button",{name:submit,exact:true}).click();}
try{
  const pm=await context.newPage();await pm.goto(provider.webLoginUrl);
  const news=pm.getByRole("dialog",{name:/What's new/});if(await news.isVisible())await news.getByRole("button",{name:"Close",exact:true}).click();
  if(!(await pm.getByRole("button",{name:"Oh My AIHub",exact:true}).isVisible())) {
    await pm.getByRole("button",{name:"Plugins",exact:true}).click();
    if(await pm.getByRole("tab",{name:"Discover",exact:true}).isVisible())await pm.getByRole("tab",{name:"Discover",exact:true}).click();
    await pm.locator("input.pm-minput").fill("github:faithleysath/magpie-oh-my-aihub#feature/local-web-console");await pm.locator("form.pm-manual button[type=submit]").click();
  }
  await pm.getByRole("button",{name:"Oh My AIHub",exact:true}).waitFor({timeout:60000});await pm.getByRole("button",{name:"Oh My AIHub",exact:true}).click();
  const frame=pm.frameLocator("iframe");await frame.locator("#console-origin").filter({hasText:/^http:\/\/127\.0\.0\.1:/}).waitFor({timeout:20000});const origin=(await frame.locator("#console-origin").innerText()).trim();
  const p=await pair(pm,origin);pass("second provider installed from GitHub and paired through Magpie UI");
  if(await p.locator("#wizard-next").isVisible()) {
    await p.locator("#wizard-next").click();await p.locator("#sharing").check();await p.locator("#wizard-next").click();await p.locator("#network-name").fill(runtime.networkName);await p.locator("#network-secret").fill(runtime.networkSecret);await p.locator("#network-peers").fill(`tcp://${provider.lan}:${runtime.nodes.provider.ports.listen}`);
    await p.locator("#advanced-network summary").click();await p.locator("#network-catalog-port").fill(String(provider.ports.catalog));await p.locator("#network-socks-port").fill(String(provider.ports.socks));await p.locator("#save").click();await p.getByText("配置已保存。请查看安全状态，确认网络是否就绪。",{exact:true}).waitFor({timeout:60000});await p.locator("#wizard-done").click();
  }
  await p.locator("#nav-sharing").click();await p.getByRole("button",{name:"读取本机模型",exact:true}).click();await p.locator('#sharing-panel .shared-model-list input[type=checkbox]').waitFor();await p.locator('#sharing-panel .shared-model-list input[type=checkbox]').check();await p.getByRole("button",{name:"保存模型范围",exact:true}).click();await p.getByLabel("展示名称",{exact:true}).fill("林间实验室 · 第二提供者");await p.getByLabel("建议申请额度（USD）",{exact:true}).fill("1");await p.getByRole("button",{name:"保存目录说明",exact:true}).click();await p.getByRole("button",{name:"发布目录",exact:true}).click();await confirm(p,"发布模型目录");
  await p.getByText("查看完整目录身份与报价",{exact:true}).click();const fingerprint=(await p.getByText("完整身份指纹",{exact:true}).locator("..").locator("span").innerText()).trim();if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error("provider full fingerprint absent");pass("provider uses UI for network, native model selection, signed catalog publication");
  const cm=await context.newPage();await cm.goto(consumer.webLoginUrl);await cm.getByRole("button",{name:"Oh My AIHub",exact:true}).click();const cf=cm.frameLocator("iframe");await cf.locator("#console-origin").filter({hasText:/^http:/}).waitFor();const c=await pair(cm,(await cf.locator("#console-origin").innerText()).trim());await c.locator("#nav-discovery").click();
  let card=c.locator("#discovery-panel article").filter({hasText:"林间实验室 · 第二提供者"});for(let i=0;i<5;i++){await c.getByRole("button",{name:"刷新目录",exact:true}).click();try{await card.waitFor({timeout:7000});break;}catch{if(i===4)throw new Error("second provider not discovered");}}
  await card.getByRole("button",{name:"核对并接受身份",exact:true}).click();const cd=c.locator("dialog[open]");if((await cd.locator("code.fingerprint").innerText()).trim()!==fingerprint)throw new Error("TOFU fingerprints differ");await cd.getByRole("checkbox").check();await cd.getByRole("button",{name:"接受此身份",exact:true}).click();await cd.waitFor({state:"hidden"});
  await card.getByRole("button",{name:"选择模型并申请",exact:true}).click();await cd.locator("input[data-model-id]").check();await cd.getByLabel("我已查看模型价格；价格未锁定（priceLocked: false）",{exact:true}).check();await cd.getByRole("button",{name:"生成连接申请",exact:true}).click();await cd.getByRole("button",{name:"下载连接申请",exact:true}).waitFor();let download=c.waitForEvent("download");await cd.getByRole("button",{name:"下载连接申请",exact:true}).click();await(await download).saveAs(join(privateDir,"request.json"));await cd.getByRole("button",{name:"关闭",exact:true}).click();pass("consumer compares full fingerprint with provider UI and exports bound request");
  await importFile(p,"导入伙伴的申请文件",join(privateDir,"request.json"),"导入并核对申请");await p.locator("dialog[open]").waitFor({state:"hidden"});await p.getByRole("button",{name:"核对并审批",exact:true}).click();const pd=p.locator("dialog[open]");await pd.locator("input[data-model-id]").check();await pd.getByRole("spinbutton").fill("1");await pd.getByLabel("我已核对申请方、当前报价、模型与额度，明确批准此次授权",{exact:true}).check();await pd.getByRole("button",{name:"批准此申请",exact:true}).click();await pd.waitFor({state:"hidden",timeout:30000});
  await p.getByRole("button",{name:"交付访问授权",exact:true}).click();await pd.getByRole("checkbox").check();await pd.getByRole("button",{name:"显示本次授权文件",exact:true}).click();await pd.getByRole("button",{name:"下载授权文件",exact:true}).waitFor();download=p.waitForEvent("download");await pd.getByRole("button",{name:"下载授权文件",exact:true}).click();await(await download).saveAs(join(privateDir,"authorization.json"));await pd.getByRole("button",{name:"完成并隐藏",exact:true}).click();pass("provider manually approves positive scoped cap and privately exports authorization");
  await c.locator("#nav-connections").click();await importFile(c,"导入伙伴授权",join(privateDir,"authorization.json"),"验证并连接");await cd.getByRole("button",{name:"创建此伙伴连接",exact:true}).waitFor();await cd.getByRole("checkbox").check();await cd.getByRole("button",{name:"创建此伙伴连接",exact:true}).click();await cd.waitFor({state:"hidden",timeout:60000});
  await c.waitForFunction(()=>document.querySelectorAll("#connections-panel article").length===2);await c.screenshot({path:join(out,"webkit-two-providers.png"),fullPage:true});pass("consumer imports authorization and retains two independent native Remote Magpies");
  writeFileSync(join(out,"webkit-sharing.json"),JSON.stringify({at:new Date().toISOString(),engine:"WebKit",version:browser.version(),steps,pass:true,cliBusinessOperations:false,manualAdminHttp:false},null,2));
}catch(error){writeFileSync(join(out,"webkit-sharing-failure.json"),JSON.stringify({at:new Date().toISOString(),steps,pass:false,error:String(error).replace(/https?:\/\/[^\s]+/g,"<url>").slice(0,800)},null,2));throw new Error("WebKit sharing journey failed; inspect sanitized artifact");}
finally{await context.close();await browser.close();}
