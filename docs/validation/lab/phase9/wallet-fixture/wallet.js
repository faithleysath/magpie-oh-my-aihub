import { consumeTicketFragment, createSessionClient } from "/session.js";
const ticket = consumeTicketFragment(location, history);
const $ = (id) => globalThis.document.getElementById(id);
let document = null;
let transfer = null;
let eventOperation = null;
let current = null;
let busy = false;
let authenticated = false;
const client = createSessionClient({ onExpired() { authenticated = false; clearMemory(); $("main").hidden = true; $("session").textContent = "私有夹具会话已结束。请由维护者重新打开私有 runtime 文件中的启动地址。"; } });
function notice(message) { $("notice").textContent = message; }
function show(id, value) { $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function clearMemory() {
  document = null; transfer = null; eventOperation = null;
  for (const id of ["deposit-file", "transfer-file"]) $(id).value = "";
  for (const id of ["deposit-review", "transfer-review", "event-result"]) show(id, "已清除");
  for (const id of ["sign-consent", "event-consent"]) $(id).checked = false;
  for (const id of ["sign", "event", "event-replay"]) $(id).disabled = true;
}
async function run(work) {
  if (busy) return;
  busy = true;
  const buttons = [...globalThis.document.querySelectorAll("button")];
  const disabled = buttons.map((button) => button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  try { await work(); }
  catch (error) { notice(error.message || "夹具操作结果未知，请刷新核对；不要重复生成操作。"); }
  finally { busy = false; buttons.forEach((button, index) => { button.disabled = disabled[index]; }); updateButtons(); }
}
function updateButtons() { $("logout").disabled = !authenticated; $("sign").disabled = !document || !$("sign-consent").checked; $("event").disabled = !transfer || !$("event-consent").checked; $("event-replay").disabled = !eventOperation; }
async function readFile(input) {
  const file = input.files?.[0];
  if (!file || file.size > 48 * 1024) throw new Error("请选择不超过48KiB的生产 JSON 文件。");
  return JSON.parse(await file.text());
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = globalThis.document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function refresh() { current = await client.state(); show("state", current); $("payer").textContent = current.wallet.payerAddress || "未生成"; }
async function control(name, input, operationId = crypto.randomUUID()) { return client.action("chain-control", { name, input, operationId, consent: true }); }
function selectedChain() { const value = Number($("chain").value); if (value !== 97 && value !== 84532) throw new Error("请明确选择模拟网络。"); return value; }
$("generate").onclick = () => run(async () => { await client.action("wallet-generate", {}); clearMemory(); await refresh(); notice("新的无资金合成账户已生成；密钥只在夹具进程内存。"); });
$("reset").onclick = () => run(async () => { await client.action("wallet-reset", {}); clearMemory(); await refresh(); });
$("deposit-file").onchange = () => run(async () => {
  document = null; $("sign-consent").checked = false;
  const candidate = await readFile($("deposit-file"));
  const reviewed = await client.action("wallet-review", { document: candidate });
  document = reviewed.document; show("deposit-review", reviewed); notice("签名域与摘要已验证，请逐项核对并勾选确认。");
});
$("sign-consent").onchange = updateButtons;
$("sign").onclick = () => run(async () => {
  if (!document || !$("sign-consent").checked) throw new Error("请先导入并确认文件。");
  const signature = await client.action("wallet-sign", { document, consent: true });
  download(signature, "local-fixture-deposit-signature.json");
  document = null; $("deposit-file").value = ""; $("sign-consent").checked = false; show("deposit-review", "签名文件已下载，输入已清除。请回生产控制台导入。" );
});
$("clear-document").onclick = clearMemory;
$("transfer-file").onchange = () => run(async () => {
  transfer = null; eventOperation = null; $("event-consent").checked = false;
  const candidate = await readFile($("transfer-file"));
  transfer = await client.action("transfer-review", { document: candidate });
  show("transfer-review", { source: candidate, exactSyntheticEvent: transfer }); notice("这不是付款。请核对生产指令与本地事件字段。");
});
$("event-consent").onchange = updateButtons;
$("event").onclick = () => run(async () => {
  if (!transfer || !$("event-consent").checked) throw new Error("请先导入指令并确认模拟事件。");
  const input = { ...transfer }, variant = $("variant").value;
  if (variant === "amount") input.amountRaw = (BigInt(input.amountRaw) + 1n).toString();
  if (variant === "sender") input.from = "0x" + "11".repeat(20);
  if (variant === "token") input.tokenContract = "0x" + "22".repeat(20);
  if (variant === "chain") input.chainId = input.chainId === 97 ? 84532 : 97;
  eventOperation = { input, operationId: crypto.randomUUID() };
  show("event-result", await control("transfer", input, eventOperation.operationId));
  notice("合成日志已持久化到新块。先在生产控制台观察事件，再推进最终性；未付款。"); await refresh();
});
$("event-replay").onclick = () => run(async () => { show("event-result", await control("transfer", eventOperation.input, eventOperation.operationId)); await refresh(); notice("同一操作编号返回同一事件；未添加第二笔事件。"); });
$("mine").onclick = () => run(async () => { await control("mine", { chainId: selectedChain(), blocks: Number($("blocks").value) }); await refresh(); });
$("finalize").onclick = () => run(async () => { const chainId = selectedChain(); await refresh(); const chain = current.chains.find((item) => item.chainId === chainId); await control("finalize", { chainId, block: chain.head }); await refresh(); });
$("flags").onclick = () => run(async () => { await control("flags", { chainId: selectedChain(), failAll: $("fail-all").checked, failLogs: $("fail-logs").checked, wrongChain: $("wrong-chain").checked, wrongDecimals: $("wrong-decimals").checked, receipt: $("receipt").value }); await refresh(); });
$("refresh").onclick = () => run(refresh);
$("export-evidence").onclick = () => run(async () => { download(await client.action("evidence-export", {}), "local-fixture-evidence.json"); });
$("logout").onclick = () => run(async () => { await client.action("wallet-reset", {}); await client.logout(); authenticated = false; clearMemory(); $("main").hidden = true; $("session").textContent = "已清除临时钱包并退出。"; });
globalThis.addEventListener("pagehide", () => { clearMemory(); client.dispose(); });
await run(async () => { await client.open(ticket); authenticated = true; $("main").hidden = false; $("logout").disabled = false; $("session").textContent = "已通过私有夹具会话认证。"; await refresh(); });
