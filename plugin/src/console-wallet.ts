// Authenticated browser wallet workflows. Existing domain classes own every credit/cap decision.
import { existsSync, readFileSync, statSync } from "node:fs";
import { canonicalJson } from "./catalog.ts";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import { redact, registerSecret } from "./log.ts";
import { maskSensitiveText } from "./page-snapshot.ts";
import { ConsoleInputError } from "./console-server.ts";
import { NetworkRegistry } from "./networks.ts";
import { walletView, type KeyReadback, type WalletViewInput } from "./walletview.ts";
import { verifyStatement } from "./walletstatement.ts";
import { LedgerHistoryCursorError } from "./ledger.ts";
import { formatTokenAmount } from "./walletamount.ts";
import type { Service } from "./service.ts";
import type { Wallet } from "./wallet.ts";
import { verifyIntentSignature, type DepositIntent } from "./deposits.ts";
import type { ConsumerView } from "./provisioner.ts";
import { boundedWalletDocument, externalSignatureDocument, parseWalletSignature, planWalletIntent, previewDepositDocument, UUID, WalletWorkflowError, walletAddress, walletBad, walletFields, walletHash, walletIntentDocument, walletObject, walletText } from "./wallet-workflows.ts";

export const WALLET_CONSOLE_ACTIONS = ["wallet-refresh", "wallet-network", "wallet-start", "wallet-stop", "wallet-asset-register", "wallet-asset-toggle", "wallet-receiving", "wallet-intent-preview", "wallet-intent-create", "wallet-intent-document", "wallet-signature-import", "wallet-intent-cancel", "wallet-scan", "wallet-anomaly-resolve", "wallet-statement", "wallet-statement-preview", "deposit-document-preview", "deposit-signature-document", "accounting-refresh", "accounting-history", "usage-gap-resolve"] as const;
// Leave room for the JSON action envelope under the transport's 64 KiB body
// bound. A statement exported here must fit the consumer's import path too.
const STATEMENT_DOCUMENT_LIMIT = 48 * 1024;
const owners = new WeakMap<Service, ConsoleWallet>();
function owner(service: Service): ConsoleWallet {
  let value = owners.get(service);
  if (!value) { value = new ConsoleWallet(service); owners.set(service, value); }
  return value;
}
export function consoleWalletState(service: Service) { return owner(service).snapshot(); }
export async function consoleWalletAction(service: Service, name: string, input: Record<string, unknown>): Promise<unknown> {
  try { return await owner(service).action(name, input); }
  catch (e) {
    if (e instanceof WalletWorkflowError) throw new ConsoleInputError(e.message);
    throw e; // Uncertain RPC/write failures are never converted to a safe-to-retry validation error.
  }
}
const safeText = (value: string) => maskSensitiveText(redact(value)).replace(/`[^`]*`/g, "（请使用对应操作按钮）");
function scrub<T>(value: T): T {
  if (typeof value === "string") return safeText(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,scrub(v)])) as T;
  return value;
}
function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return walletBad(`${label}无效`);
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return walletBad("开关必须为 true 或 false"); return value; }
interface IntentOperation { requestId: string; inputHash: string; consumerId: string; state: "reserved"|"created"; invoiceId: string|null; at: string; }

export class ConsoleWallet {
  private queue: Promise<unknown> = Promise.resolve();
  private readbacks: Record<string, KeyReadback> = {};
  private readbackBindings: Record<string,string> = {};
  private binding(c:ConsumerView):string {
    const record=this.service.provisioner.find(c.consumerId);
    return walletHash({keyId:c.keyId,window:c.window,windowId:c.ledger?.windowId,priceVersion:c.priceVersion,
      quote:c.acceptedQuoteHash,models:c.models,cap:c.capUsd,used:c.usedUsd,left:c.leftUsd,calls:c.calls,
      ledger:c.ledger,pending:c.pending,paused:c.paused,revoked:c.revokedAt,
      // Never emitted or retained outside this private fingerprint.
      secret:record?.secret??null,lastCheck:record?.lastCheck??null});
  }
  private walletUnavailable = false;
  private evidenceAt: string | null = null;
  private viewAt: string | null = null;
  constructor(private service: Service, private file = statePath("console-wallet-operations.json")) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  private operations(): IntentOperation[] {
    if (!existsSync(this.file)) return [];
    try {
      if (statSync(this.file).size > 256 * 1024) throw new Error();
      const raw = JSON.parse(readFileSync(this.file,"utf8"));
      if (raw.version !== 1 || !Array.isArray(raw.operations) || raw.operations.length > 500) throw new Error();
      const list = raw.operations as IntentOperation[];
      if (list.some(r => !UUID.test(r.requestId) || !/^[0-9a-f]{64}$/.test(r.inputHash) || typeof r.consumerId !== "string" || !["reserved","created"].includes(r.state) || typeof r.at !== "string" || (r.invoiceId !== null && typeof r.invoiceId !== "string")) || new Set(list.map(r=>r.requestId)).size !== list.length) throw new Error();
      return list;
    } catch { return walletBad("充值请求记录不可读取，请修复后再创建，不能重复提交结果不明的请求"); }
  }
  private save(operations: IntentOperation[]) { writeJsonAtomic(this.file,{version:1,operations},0o600); }
  private wallet(): Wallet {
    try {const w=this.service.walletForConfiguration();this.walletUnavailable=false;return w;}
    catch(e){this.walletUnavailable=true;throw e;}
  }
  private enabledNetwork(w:Wallet,value:unknown):number {
    const id=integer(value,"网络"),net=w.registryView().network(id);
    if(!net?.enabled||net.networkType!=="testnet")return walletBad("请选择已启用的测试网络");
    return id;
  }
  private consumer(id: unknown) {
    const consumerId = walletText(id,"消费者");
    const value = this.service.provisioner.all().find(c=>c.consumerId===consumerId);
    if (!value) return walletBad("请选择此节点实际管理的消费者");
    return value;
  }
  private providerId(raw: unknown, w: Wallet): string {
    const local = this.service.config()?.nodeId;
    if (!local) return walletBad("请先配置本机节点");
    if (raw === undefined || raw === local) return local;
    const legacy = walletText(raw,"收款方");
    if (!w.receivingAddresses().some(r=>r.providerId===legacy)) return walletBad("请选择已有收款地址的提供方");
    return legacy;
  }
  private plan(input: Record<string,unknown>) {
    const w = this.wallet(), consumer = this.consumer(input.consumerId);
    const chainId = integer(input.chainId,"网络"), network = w.registryView().network(chainId);
    const assetId = walletText(input.assetId,"代币",160), asset = w.registryView().asset(assetId);
    if (!network || !asset) return walletBad("请选择已登记的网络和测试代币");
    const providerId = this.providerId(input.providerId,w), recipientAddress = w.receivingAddressFor(providerId,chainId);
    if (!recipientAddress) return walletBad("此网络尚未配置收款地址");
    return planWalletIntent({consumer,providerId,network,asset,recipientAddress,
      amount: input.amount as string,ttlSec:integer(input.ttlSec,"有效期",60,604800),
      pending:w.chainStore().openIntentsFor(consumer.consumerId)});
  }
  private invoice(input: Record<string,unknown>): {w:Wallet;intent:DepositIntent} {
    const c = this.consumer(input.consumerId), w=this.wallet();
    const intent=w.chainStore().intent(walletText(input.invoiceId,"请求编号"));
    if (!intent || intent.consumerId !== c.consumerId) return walletBad("充值请求不属于选中的消费者");
    return {w,intent};
  }
  private document(w:Wallet,intent:DepositIntent) {
    const net=w.registryView().network(intent.chainId), asset=w.registryView().asset(intent.assetId);
    if (!net || !asset) return walletBad("请求的网络或代币记录不可读取");
    return walletIntentDocument(intent,net,asset);
  }
  private transfer(w:Wallet,intent:DepositIntent) {
    if (intent.status !== "signed" || !intent.payerAddress || Date.parse(intent.expiresAt)<=Date.now()) return null;
    const asset=w.registryView().asset(intent.assetId);
    if (!asset) return walletBad("测试代币记录不可读取");
    return {schema:"ohmyaihub.transfer-instructions/v1" as const,invoiceId:intent.invoiceId,consumerId:intent.consumerId,providerId:intent.providerId,
      chainId:intent.chainId,assetId:intent.assetId,contractAddress:intent.tokenContract,symbol:asset.symbol,decimals:intent.rateDecimals,
      amountRaw:intent.expectedAmountRaw,amountTokens:formatTokenAmount(intent.expectedAmountRaw,intent.rateDecimals),
      recipientAddress:intent.recipientAddress,payerAddress:intent.payerAddress,expiresAt:intent.expiresAt};
  }
  snapshot() {
    const w=this.service.consoleWalletModule();
    const consumers=this.service.provisioner.all();
    const base={availability:w?"available":this.walletUnavailable?"unavailable":"uninitialized",error:(this.walletUnavailable?"钱包本地记录不可读取，请修复后重新刷新":null) as string|null,viewAt:this.viewAt,evidenceAt:this.evidenceAt,
      source:this.evidenceAt?"explicit-refresh":"local",view:null as ReturnType<typeof walletView>|null,
      registry:{networks:[] as any[],assets:[] as any[]},receiving:[] as any[],intents:[] as any[],anomalies:[] as any[],
      consumers:consumers.map(c=>({consumerId:c.consumerId,models:c.models,revokedAt:c.revokedAt,paused:scrub(c.paused),pending:c.pending,
        eligibleForIntent:!c.revokedAt,blockers:c.revokedAt?["授权已撤销"]:c.paused?["消费者已暂停，充值不会自动恢复授权"]:[]})),
      intentOperations:[] as any[],truncated:false,scanningChains:w?.scanningChains()??[]};
    try { base.intentOperations=this.operations().slice(-100).map(r=>({requestId:r.requestId,consumerId:r.consumerId,status:r.state==="created"?"created":"unknown",invoiceId:r.invoiceId,at:r.at})); }
    catch { base.error="充值请求记录不可读取，已阻止新建请求"; }
    if (!w) return base;
    const status=w.statusLocal({consumerIds:consumers.map(c=>c.consumerId)});
    // Never reuse a gateway measurement across a new key/cap/pause or indefinitely.
    const readbacks:Record<string,KeyReadback>={};
    for(const c of consumers){const r=this.readbacks[c.consumerId]; if(r && this.readbackBindings[c.consumerId]===this.binding(c) && !c.paused && !c.revokedAt && Math.abs(c.capUsd-r.capUsd)<1e-9 && Date.now()-Date.parse(r.at)<=60_000) readbacks[c.consumerId]=r;}
    const a=this.service.accountingStatus();
    const input:WalletViewInput={wallet:status,consumers,readbacks,
      // Bounded UI history; authoritative accounting totals already live on ConsumerView.
      deposits:Object.fromEntries(consumers.map(c=>[c.consumerId,this.service.ledger?.depositsFor(c.consumerId,100)??[]])),
      accounting:{state:a.uncertain?"uncertain":a.lastCheckAt?"ok":"unknown",reason:a.uncertainReason,serving:a.serving}};
    const view=walletView(input);
    view.chains=view.chains.map(c=>({...c,rpc:c.rpc.map(r=>({...r,url:"",lastError:r.lastError?safeText(r.lastError):null})),lastError:c.lastError?safeText(c.lastError):null}));
    view.deposits=view.deposits.map(d=>({...d,stateDetail:safeText(d.stateDetail),keyUsableReason:safeText(d.keyUsableReason),retry:null,
      nextStep:({"awaiting-signature":"下载签名文件并在外部钱包签名",confirming:"等待此网络的最终确认",crediting:"稍后重新扫描并检查额度",credited:"查看额度验证时间",unclaimed:"核对转账信息，请勿重复发送",uncertain:"等待或核对异常，请勿重复发送",reverted:"核对回滚原因并审查消费者暂停"} as Record<string,string>)[d.state]??"查看请求详情和对应操作",
      explorerUrl:d.explorerUrl&&/^https?:\/\//.test(d.explorerUrl)?d.explorerUrl:null,steps:d.steps.map(s=>({...s,detail:safeText(s.detail)}))}));
    view.consumers=view.consumers.map(c=>({...c,stateDetail:safeText(c.stateDetail),paused:scrub(c.paused),accounting:scrub(c.accounting)}));
    view.alerts=view.alerts.map(a=>({...a,detail:safeText(a.detail),nextStep:"请查看对应请求、消费者或网络设置"}));
    base.view=view;base.truncated=view.truncated;
    base.registry.networks=status.registry.networks.map(n=>({chainId:n.chainId,displayName:n.displayName,networkType:n.networkType,enabled:n.enabled,finality:n.finality,rpcConfigured:n.endpoints.length>0,rpcCount:n.endpoints.length,running:w.runningChains().includes(n.chainId)}));
    base.registry.assets=status.registry.assets.map(asset=>{const checked=status.chains.find(c=>c.chainId===asset.chainId)?.assets.find(a=>a.assetId===asset.assetId);return {...asset,onchainDecimals:checked?.onchainDecimals??null,decimalsOk:checked?.decimalsOk??null};});
    base.receiving=status.receiving;
    base.intents=status.intents.map(i=>({invoiceId:i.invoiceId,consumerId:i.consumerId,providerId:i.providerId,chainId:i.chainId,assetId:i.assetId,expectedAmountRaw:i.expectedAmountRaw,recipientAddress:i.recipientAddress,payerAddress:i.payerAddress,status:i.status,attributionStatus:i.attributionStatus,expiresAt:i.expiresAt,requestedAt:i.requestedAt}));
    base.anomalies=status.anomalies.map(a=>({...a,detail:safeText(a.detail),resolutionNote:a.resolutionNote?safeText(a.resolutionNote):null}));
    return base;
  }
  private async refresh(consumerId?:string,probeRpc=false) {
    const w=this.wallet();
    if(probeRpc) await w.health();
    const before=Object.fromEntries(this.service.provisioner.all().map(c=>[c.consumerId,this.binding(c)]));
    const e=await this.service.walletEvidence(consumerId?{consumerId}:{});
    if(e){
      if(consumerId) {delete this.readbacks[consumerId];delete this.readbackBindings[consumerId];}
      else {this.readbacks={};this.readbackBindings={};}
      for(const c of this.service.provisioner.all()) {
        const binding=this.binding(c), measured=e.readbacks[c.consumerId];
        if(measured&&before[c.consumerId]===binding){this.readbacks[c.consumerId]=measured;this.readbackBindings[c.consumerId]=binding;}
      }
      this.evidenceAt=new Date().toISOString();
    }
    this.viewAt=new Date().toISOString();
    return this.snapshot();
  }
  async action(name:string,input:Record<string,unknown>):Promise<any> {
    // One queue for browser wallet writes: no preview/create or registry-change race.
    return this.serial(async()=>{
      switch(name){
        case "wallet-refresh":walletFields(input,["consumerId","probeRpc"]);return {wallet:await this.refresh(input.consumerId===undefined?undefined:this.consumer(input.consumerId).consumerId,input.probeRpc===undefined?false:boolean(input.probeRpc))};
        case "wallet-network":{
          walletFields(input,["chainId","enabled","rpcEndpoints"]);const w=this.wallet(), chainId=integer(input.chainId,"网络");
          const current=w.registryView().network(chainId);if(!current||current.networkType!=="testnet")return walletBad("只能配置已登记的测试网络");
          const enabled=input.enabled===undefined?current.enabled:boolean(input.enabled);
          let endpoints=current.rpcEndpoints;
          if(input.rpcEndpoints!==undefined){if(!Array.isArray(input.rpcEndpoints)||input.rpcEndpoints.length>8||input.rpcEndpoints.some(v=>typeof v!=="string"||v.length>2048))return walletBad("RPC 地址列表无效");endpoints=(input.rpcEndpoints as string[]).map(v=>v.trim());for(const url of endpoints){try{const u=new URL(url);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.hash)throw new Error();}catch{return walletBad("RPC 需要不含登录信息的 HTTP 或 HTTPS 地址");}}}
          if(enabled&&!endpoints.length)return walletBad("启用网络前至少配置一个 RPC 地址");
          // Validate complete patch before persisting either field (including enabled+empty).
          const validation=new NetworkRegistry({version:1,networks:w.networks().map(n=>n.chainId===chainId?{...n,enabled,rpcEndpoints:endpoints}:n),assets:w.allAssets()}); void validation;
          if(!enabled)w.setNetworkEnabled(chainId,false);
          if(input.rpcEndpoints!==undefined){for(const e of endpoints)registerSecret(e);w.setRpcEndpoints(chainId,endpoints);}
          if(enabled)w.setNetworkEnabled(chainId,true);
          if(!enabled)await w.settleScans();this.readbacks={};return {wallet:this.snapshot()};
        }
        case "wallet-start":walletFields(input,[]);this.wallet().start();return {wallet:this.snapshot()};
        case "wallet-stop":walletFields(input,[]);this.wallet().stop();await this.wallet().settleScans();return {wallet:this.snapshot()};
        case "wallet-asset-register":{
          walletFields(input,["chainId","contractAddress","symbol","name","expectedDecimals","nanosPerToken","pricingNote"]);
          const chainId=integer(input.chainId,"网络"),contractAddress=walletAddress(input.contractAddress),symbol=walletText(input.symbol,"符号",32),name=walletText(input.name,"名称",100),expectedDecimals=integer(input.expectedDecimals,"精度",0,36),nanosPerToken=walletText(input.nanosPerToken,"测试兑换率",40),pricingNote=walletText(input.pricingNote,"说明",300);
          if(!/^\d+$/.test(nanosPerToken)||BigInt(nanosPerToken)<=0n||BigInt(nanosPerToken)>BigInt(Number.MAX_SAFE_INTEGER))return walletBad("测试兑换率必须是有效正整数 nano-USD");
          if(!/^[A-Za-z0-9 ._-]{1,32}$/.test(symbol)||(!/^(Mock|Test|t)/i.test(symbol)&&!/mock|test/i.test(name)))return walletBad("代币名称或符号必须明确标记为 Mock/Test");
          const w=this.wallet();this.enabledNetwork(w,chainId);
          let asset:Awaited<ReturnType<Wallet["registerTestAsset"]>>;
          try{asset=await w.registerTestAsset({chainId,contractAddress,symbol,name,expectedDecimals,nanosPerToken,pricingNote});}
          catch(e){if(e instanceof Error&&/reports .* decimals|did not answer decimals/.test(e.message))return walletBad("合约报告的精度与填写内容不符，未登记代币");throw e;}
          return {asset,wallet:this.snapshot()};
        }
        case "wallet-asset-toggle":walletFields(input,["assetId","enabled"]);{const assetId=walletText(input.assetId,"代币",160);if(!this.wallet().registryView().asset(assetId))return walletBad("代币未登记");this.wallet().setAssetEnabled(assetId,boolean(input.enabled));return {wallet:this.snapshot()};}
        case "wallet-receiving":walletFields(input,["chainId","address"]);{const w=this.wallet();w.setReceivingAddress(this.providerId(undefined,w),this.enabledNetwork(w,input.chainId),walletAddress(input.address));return {wallet:this.snapshot()};}
        case "wallet-intent-preview":walletFields(input,["consumerId","providerId","chainId","assetId","amount","ttlSec"]);return {preview:this.plan(input)};
        case "wallet-intent-create":{
          walletFields(input,["requestId","consumerId","providerId","chainId","assetId","amount","ttlSec","previewHash","ackPaused"]);
          const requestId=walletText(input.requestId,"操作编号").toLowerCase();if(!UUID.test(requestId))return walletBad("操作编号必须是 UUID");
          if(input.ackPaused!==undefined)boolean(input.ackPaused);
          const consumer=this.consumer(input.consumerId), inputHash=walletHash(input), operations=this.operations(),existing=operations.find(r=>r.requestId===requestId);
          const w=this.wallet();
          if(existing){if(existing.inputHash!==inputHash)return walletBad("同一操作编号不能用于不同请求");if(existing.state!=="created"||!existing.invoiceId)return walletBad("原请求结果不明，请核对并继续已有请求，不能盲目重试");const intent=w.chainStore().intent(existing.invoiceId);if(!intent)return walletBad("原请求记录不可读取，不能重复创建");return {document:this.document(w,intent),transfer:this.transfer(w,intent),wallet:this.snapshot()};}
          if(operations.some(r=>r.consumerId===consumer.consumerId&&r.state==="reserved"))return walletBad("此消费者存在结果不明的请求，请先核对原请求记录，不能换编号重试");
          const preview=this.plan(input);if(preview.previewHash!==input.previewHash)return walletBad("请求信息已变化，请重新预览并确认");
          if(preview.blockers.length)return walletBad(preview.blockers[0]!);if(consumer.paused&&input.ackPaused!==true)return walletBad("消费者已暂停，请明确确认充值不会自动恢复授权");
          if(operations.length>=500)return walletBad("请求操作记录已满，请审计后再继续");
          const record:IntentOperation={requestId,inputHash,consumerId:consumer.consumerId,state:"reserved",invoiceId:null,at:new Date().toISOString()};operations.push(record);this.save(operations);
          const result=w.requestIntent({providerId:preview.providerId,consumerId:consumer.consumerId,chainId:preview.chainId,assetId:preview.assetId,amountRaw:preview.amountRaw,ttlSec:preview.ttlSec});
          record.state="created";record.invoiceId=result.intent.invoiceId;this.save(operations);
          return {document:this.document(w,result.intent),transfer:null,wallet:this.snapshot()};
        }
        case "wallet-intent-document":walletFields(input,["consumerId","invoiceId"]);{const {w,intent}=this.invoice(input);return {document:this.document(w,intent),transfer:this.transfer(w,intent),wallet:this.snapshot()};}
        case "wallet-signature-import":{
          walletFields(input,["consumerId","invoiceId","document"]);const {w,intent}=this.invoice(input);const signature=parseWalletSignature(input.document,intent.invoiceId);
          if(intent.status==="signed"&&intent.payerAddress){
            const network=w.registryView().network(intent.chainId),asset=w.registryView().asset(intent.assetId);
            if(!network||!asset||intent.payerAddress.toLowerCase()!==signature.payerAddress.toLowerCase())return walletBad("请求已绑定另一签名钱包");
            const checked=verifyIntentSignature({intent,network,asset,signature:signature.signature,expectedPayer:intent.payerAddress});
            if(!checked.ok||Date.parse(intent.expiresAt)<=Date.now())return walletBad("签名与此充值请求或付款钱包不匹配");
            return {transfer:this.transfer(w,intent),wallet:this.snapshot()};
          }
          if(intent.status!=="requested"||Date.parse(intent.expiresAt)<=Date.now())return walletBad("请求已失效或无法再次签名");
          // Cryptographic refusal occurs before setPayer. Only this known domain error is safe to report.
          let signed:ReturnType<Wallet["signIntent"]>;
          try{signed=w.signIntent({invoiceId:intent.invoiceId,...signature});}catch(e){if(e instanceof Error&&/^(signature refused|this signature|payerAddress)/.test(e.message))return walletBad("签名与此充值请求或付款钱包不匹配");throw e;}
          return {transfer:this.transfer(w,signed.intent),wallet:this.snapshot()};
        }
        case "wallet-intent-cancel":walletFields(input,["consumerId","invoiceId","reason"]);{const {w,intent}=this.invoice(input);if(intent.status==="matched")return walletBad("已匹配转账的请求不能取消");w.cancelIntent(intent.invoiceId,walletText(input.reason,"取消原因",300));return {wallet:this.snapshot()};}
        case "deposit-document-preview":walletFields(input,["document"]);return previewDepositDocument(input.document,this.service.config()?.nodeId??null);
        case "deposit-signature-document":walletFields(input,["document","signature","payerAddress"]);return externalSignatureDocument(input.document,input.signature,input.payerAddress,this.service.config()?.nodeId??null);
        case "wallet-statement-preview":{
          walletFields(input,["document"]);const raw=boundedWalletDocument(input.document,STATEMENT_DOCUMENT_LIMIT);if(raw.statement)walletFields(raw,["statement","digest"]);const verified=verifyStatement(raw);if(!verified.ok)return walletBad("账单摘要或内容校验失败");const statement=raw.statement?raw:{statement:raw,digest:raw.digest};if(this.service.config()?.nodeId&&statement.statement.consumerId!==this.service.config()?.nodeId)return walletBad("账单属于另一消费者节点");return {statement,digestVerified:true,signed:false};
        }
        case "wallet-scan":walletFields(input,["chainId"]);{const chainId=integer(input.chainId,"网络");const net=this.wallet().registryView().network(chainId);if(!net?.enabled||net.networkType!=="testnet")return walletBad("请选择已启用的测试网络");const scan=await this.wallet().scanNow(chainId);return {scan:scrub(scan),wallet:await this.refresh()};}
        case "wallet-anomaly-resolve":walletFields(input,["id","note"]);{const w=this.wallet(),id=integer(input.id,"异常编号"),note=walletText(input.note,"审计说明",500);if(!w.chainStore().anomalies().some(a=>a.id===id&&!a.resolvedAt))return walletBad("请选择未处理的异常记录");w.chainStore().resolveAnomaly(id,note);return {resolved:true,wallet:this.snapshot()};}
        case "wallet-statement":walletFields(input,["consumerId"]);{const consumerId=this.consumer(input.consumerId).consumerId;const statement=await this.service.walletStatement(consumerId);if(!statement)return walletBad("钱包账单暂不可读取");if(Buffer.byteLength(JSON.stringify(statement))>STATEMENT_DOCUMENT_LIMIT)return walletBad("账单超过 48 KiB 的浏览器交接限制，请保留完整历史记录；未导出截断账单");return {statement,wallet:this.snapshot()};}
        case "accounting-refresh":walletFields(input,["consumerId"]);{if(input.consumerId!==undefined)await this.service.checkConsoleConsumer(this.consumer(input.consumerId).consumerId);else await this.service.accountingTick();return {accounting:scrub(this.service.accountingStatus()),wallet:await this.refresh(input.consumerId as string|undefined)};}
        case "accounting-history": {
          walletFields(input,["consumerId","cursor"]);const consumerId=this.consumer(input.consumerId).consumerId;
          if(input.cursor!==undefined&&(typeof input.cursor!=="string"||input.cursor.length>2048))return walletBad("消费记录分页无效，请重新打开第一页");
          if(!this.service.ledger)return walletBad("本机持久化账本暂不可读取");
          try { const result=this.service.ledger.consumptionHistory(consumerId,input.cursor as string|undefined);
            return {...result,rows:result.rows.map(row=>({...row,model:safeText(row.model)}))};
          } catch(e){if(e instanceof LedgerHistoryCursorError)return walletBad(e.message);throw e;}
        }
        case "usage-gap-resolve":walletFields(input,["consumerId","logId","resolvedBy","note"]);{const c=this.consumer(input.consumerId),logId=walletText(input.logId,"日志记录",128),resolvedBy=walletText(input.resolvedBy,"审计人",100),note=walletText(input.note,"审计说明",500);if(!c.ledger?.gaps.some(g=>g.logId===logId&&!g.resolvedAt))return walletBad("请选择尚未解决的使用记录缺口");await this.service.resolveConsumerGap(c.consumerId,{logId,resolvedBy,note});return {wallet:this.snapshot()};}
        default:return walletBad("不支持的钱包操作");
      }
    });
  }
}
