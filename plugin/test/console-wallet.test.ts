import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConsoleWallet, consoleWalletState } from "../src/console-wallet.ts";
import { previewDepositDocument, parseWalletSignature, externalSignatureDocument } from "../src/wallet-workflows.ts";
import { createLab, ensureConsumer, PROVIDER_ID } from "./support/wallet-lab.ts";
import { signDigest, TEST_PAYER } from "./support/signer.ts";
import { Wallet } from "../src/wallet.ts";
import { ChainStore } from "../src/chainstore.ts";
import { defaultRegistry } from "../src/networks.ts";
import { Service } from "../src/service.ts";
import { FakeMagpie } from "./support/fake-magpie.ts";

const closers:(()=>void)[]=[];
afterEach(()=>{for(const close of closers.splice(0))close();});
async function setup(){
 const lab=createLab();closers.push(()=>lab.close());await ensureConsumer(lab);
 const accounting={uncertain:false,lastCheckAt:new Date().toISOString(),serving:true,uncertainReason:null};
 const service={config:()=>({nodeId:PROVIDER_ID}),provisioner:lab.provisioner,ledger:lab.ledger,
  consoleSnapshot:()=>({}),consoleWalletModule:()=>lab.wallet,walletForConfiguration:()=>lab.wallet,
  accountingStatus:()=>accounting,walletEvidence:async()=>{
    const consumers=lab.views(),readbacks:Record<string,any>={};
    for(const c of consumers){const rec=lab.provisioner.find(c.consumerId)!;if(rec.paused||rec.revokedAt)continue;const {limit}=await lab.magpie.limitStatus(rec.secret) as any;readbacks[c.consumerId]={at:new Date().toISOString(),fromGateway:true,capUsd:limit!.costLimit,usedUsd:limit!.cost,leftUsd:limit!.costLeft};}
    return {wallet:lab.statusLocal(),consumers,readbacks,deposits:lab.deposits(),accounting:{state:"ok",reason:null,serving:true}};
  },walletStatement:async()=>null} as unknown as Service;
 const file=join(lab.dir,"operations.json"), adapter=new ConsoleWallet(service,file,lab.nowMs);
 const input={consumerId:"alice",chainId:84532,assetId:lab.assetFor(84532).assetId,amount:"1.000000000000000001",ttlSec:3600};
 return {lab,service,adapter,input,file};
}
const id="11111111-1111-4111-8111-111111111111";
describe("browser wallet workflows",()=>{
 test("preview/create/document/signature/import use real domain and durable same-invoice replay",async()=>{
  const {lab,service,adapter,input,file}=await setup();
  const {preview}=await adapter.action("wallet-intent-preview",input);expect(preview.amountRaw).toBe("1000000000000000001");
  const body={...input,requestId:id,previewHash:preview.previewHash};
  const created=await adapter.action("wallet-intent-create",body);expect(created.transfer).toBeNull();
  expect(previewDepositDocument(created.document,"alice",new Date(lab.clock.at)).verified).toBe(true);
  const external=externalSignatureDocument(created.document,signDigest(created.document.digest),TEST_PAYER,"alice",new Date(lab.clock.at));
  expect(external.document.invoiceId).toBe(created.document.invoiceId);expect(external.verified).toBe(true);
  expect(()=>externalSignatureDocument(created.document,"0x"+"11".repeat(65),TEST_PAYER,"alice",new Date(lab.clock.at))).toThrow();
  const reopened=new ConsoleWallet(service,file,lab.nowMs),replay=await reopened.action("wallet-intent-create",body);
  expect(replay.document.invoiceId).toBe(created.document.invoiceId);expect(lab.wallet.intents("alice")).toHaveLength(1);
  const signed=await adapter.action("wallet-signature-import",{consumerId:"alice",invoiceId:created.document.invoiceId,document:{schema:"ohmyaihub.deposit-signature/v1",invoiceId:created.document.invoiceId,payerAddress:TEST_PAYER,signature:signDigest(created.document.digest)}});
  expect(signed.transfer.schema).toBe("ohmyaihub.transfer-instructions/v1");expect(signed.transfer.amountRaw).toBe(preview.amountRaw);
  expect(signed.transfer.payerAddress.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
  await expect(adapter.action("wallet-signature-import",{consumerId:"alice",invoiceId:created.document.invoiceId,document:{signature:"0x"+"11".repeat(65),payerAddress:TEST_PAYER}})).rejects.toThrow(/签名/);
  const resumed=await adapter.action("wallet-intent-document",{consumerId:"alice",invoiceId:created.document.invoiceId});expect(resumed.transfer).toEqual(signed.transfer);
  expect(readFileSync(file,"utf8")).not.toContain("signature");
 });
 test("zero/overprecision amounts and stale recipient fail before creating invoice",async()=>{
  const {adapter,input,lab}=await setup();
  await expect(adapter.action("wallet-intent-preview",{...input,amount:"0"})).rejects.toThrow();
  await expect(adapter.action("wallet-intent-preview",{...input,amount:"0.0000000000000000001"})).rejects.toThrow();
  const {preview}=await adapter.action("wallet-intent-preview",input);
  lab.wallet.setReceivingAddress(PROVIDER_ID,84532,"0x617c2C85E9D45F1E714855FA051CcB8c538200cd");
  await expect(adapter.action("wallet-intent-create",{...input,requestId:id,previewHash:preview.previewHash})).rejects.toThrow(/变化/);
  expect(lab.wallet.intents()).toHaveLength(0);
 });
 test("unknown journal reservation and different payload never create another invoice",async()=>{
  const {adapter,input,file,lab}=await setup();const {preview}=await adapter.action("wallet-intent-preview",input);
  const body={...input,requestId:id,previewHash:preview.previewHash};await adapter.action("wallet-intent-create",body);
  await expect(adapter.action("wallet-intent-create",{...body,amount:"2"})).rejects.toThrow(/不同请求/);
  const journal=JSON.parse(readFileSync(file,"utf8"));journal.operations[0].state="reserved";journal.operations[0].invoiceId=null;writeFileSync(file,JSON.stringify(journal));
  await expect(adapter.action("wallet-intent-create",body)).rejects.toThrow(/结果不明/);expect(lab.wallet.intents()).toHaveLength(1);
 });
 test("pending older than 50-row preview still blocks new request",async()=>{
  const {adapter,input,lab}=await setup();
  const first=lab.request({consumerId:"alice",chainId:84532,amountRaw:"1"});
  for(let n=0;n<55;n++){const r=lab.request({consumerId:"alice",chainId:84532,amountRaw:String(n+2)});lab.wallet.cancelIntent(r.intent.invoiceId,"fixture old terminal row");}
  const {preview}=await adapter.action("wallet-intent-preview",input);expect(preview.pending.map((p:any)=>p.invoiceId)).toContain(first.intent.invoiceId);expect(preview.blockers).toHaveLength(1);
  await expect(adapter.action("wallet-intent-create",{...input,requestId:id,previewHash:preview.previewHash})).rejects.toThrow(/未完成/);
 });
 test("the injected clock decides expiry; exactly at the TTL the request is already expired",async()=>{
  const {adapter,input,lab}=await setup();
  const {preview}=await adapter.action("wallet-intent-preview",input); // ttlSec 3600
  const {document}=await adapter.action("wallet-intent-create",{...input,requestId:id,previewHash:preview.previewHash});
  expect(previewDepositDocument(document,"alice",new Date(lab.clock.at)).verified).toBe(true);
  lab.advance(3_600_000); // exactly the requested TTL, not one millisecond more
  expect(()=>previewDepositDocument(document,"alice",new Date(lab.clock.at))).toThrow(/过期/);
  await expect(adapter.action("wallet-signature-import",{consumerId:"alice",invoiceId:document.invoiceId,document:{schema:"ohmyaihub.deposit-signature/v1",invoiceId:document.invoiceId,payerAddress:TEST_PAYER,signature:signDigest(document.digest)}})).rejects.toThrow(/失效/);
 });
 test("import rejects tampered human-visible amount, wrong consumer and private-key fields",async()=>{
  const {adapter,input,lab}=await setup();const {preview}=await adapter.action("wallet-intent-preview",input);const {document}=await adapter.action("wallet-intent-create",{...input,requestId:id,previewHash:preview.previewHash});
  expect(()=>previewDepositDocument({...document,amount:{tokens:"2",raw:"2"}},"alice",new Date(lab.clock.at))).toThrow();
  expect(()=>previewDepositDocument(document,"other-consumer",new Date(lab.clock.at))).toThrow();
  expect(()=>parseWalletSignature({signature:"0x"+"11".repeat(65),payerAddress:TEST_PAYER,privateKey:"fixture-only"})).toThrow();
 });
 test("passive projection does no RPC and does not leak credential-bearing RPC URLs",async()=>{
  const {adapter,lab}=await setup();let calls=0;lab.wallet.health=async()=>{calls++;return [];};
  lab.wallet.setRpcEndpoints(84532,["https://rpc.example/private-api-key?token=fixture-only"]);
  const state=adapter.snapshot();expect(calls).toBe(0);expect(state.registry.networks.find(n=>n.chainId===84532)?.rpcCount).toBe(1);
  expect(JSON.stringify(state)).not.toContain("private-api-key");expect(state.view?.consumers[0]?.state).toBe("unverified");
 });
 test("production watcher credit stays unproven until explicit gateway evidence and duplicate scan cannot recredit",async()=>{
  const {adapter,input,lab}=await setup();const {preview}=await adapter.action("wallet-intent-preview",input);
  const {document}=await adapter.action("wallet-intent-create",{...input,requestId:id,previewHash:preview.previewHash});
  await adapter.action("wallet-signature-import",{consumerId:"alice",invoiceId:document.invoiceId,document:{signature:signDigest(document.digest),payerAddress:TEST_PAYER}});
  const chain=lab.chainFor(84532);chain.mine();chain.transfer({from:TEST_PAYER,to:document.recipientAddress,amount:BigInt(document.amount.raw)});
  await lab.scan(84532);expect(adapter.snapshot().view?.deposits.find(d=>d.invoiceId===document.invoiceId)?.keyUsable).toBe(false);
  const before=lab.views()[0]!.capUsd;const refreshed=await adapter.action("wallet-refresh",{consumerId:"alice"});
  expect(refreshed.wallet.view.deposits.find((d:any)=>d.invoiceId===document.invoiceId)?.keyUsable).toBe(true);
  await lab.scan(84532);expect(lab.views()[0]!.capUsd).toBe(before);
 });
 test("cached readback is invalidated by same-cap new key/window or usage/balance drift",async()=>{
  const {adapter,lab}=await setup();
  await adapter.action("wallet-refresh",{});expect(adapter.snapshot().view?.consumers[0]?.readback.fromGateway).toBe(true);
  const record=lab.provisioner.find("alice")!;record.keyId="new-key-same-cap";
  expect(adapter.snapshot().view?.consumers[0]?.readback.fromGateway).toBe(false);
  record.keyId=[...lab.magpie.keys.keys()][0]!;
  await adapter.action("wallet-refresh",{});expect(adapter.snapshot().view?.consumers[0]?.readback.fromGateway).toBe(true);
  record.lastCheck={at:new Date().toISOString(),usedUsd:.00001,leftUsd:.00009,calls:1,spent:false};
  expect(adapter.snapshot().view?.consumers[0]?.readback.fromGateway).toBe(false);
 });
 test("network patch validates all inputs before mutation",async()=>{
  const {adapter,lab}=await setup();const before=lab.wallet.networks();
  await expect(adapter.action("wallet-network",{chainId:84532,enabled:false,rpcEndpoints:["file:///fixture"]})).rejects.toThrow();expect(lab.wallet.networks()).toEqual(before);
 });
});

describe("wallet lifecycle without public RPC",()=>{
 test("Service retains fully disabled wallet configuration and passive access never initializes it",()=>{
  const dir=mkdtempSync(join(tmpdir(),"wallet-service-")),registry=defaultRegistry();registry.setNetworkEnabled(97,false);registry.setNetworkEnabled(84532,false);
  const wallet=new Wallet({registry,store:new ChainStore(join(dir,"chain.sqlite")),credit:{} as any,makeWatcher:()=>{throw new Error("must not build RPC watcher");}});closers.push(()=>wallet.close());
  // Avoid constructor state files: exercise the real access methods over explicit isolated dependencies.
  const service=Object.create(Service.prototype) as Service;(service as any).deps={walletFactory:()=>wallet};(service as any).walletInstance=undefined;
  expect(service.consoleWalletModule()).toBeNull();expect(service.walletForConfiguration()).toBe(wallet);
  expect(service.requireWallet()).toBe(wallet);wallet.setNetworkEnabled(97,true);expect(wallet.runningChains()).toEqual([]);
 });
 test("sole running chain RPC replacement restarts; all-disabled enable preserves started intent",async()=>{
  const registry=defaultRegistry();registry.setNetworkEnabled(84532,false);
  const dir=mkdtempSync(join(tmpdir(),"wallet-lifecycle-"));let scans=0,watchers=0;
  const wallet=new Wallet({registry,store:new ChainStore(join(dir,"chain.sqlite")),credit:{depositIntent:()=>({created:true}),applyDeposit:async()=>{},freezeConsumer:async()=>{},balance:()=>({depositedNanos:0,consumedNanos:0,balanceNanos:0})},makeWatcher:()=>{watchers++;return {scan:async()=>{scans++;return {chainId:97};}} as any;}});
  closers.push(()=>wallet.close());wallet.start();await wallet.settleScans();expect(wallet.runningChains()).toEqual([97]);
  wallet.setRpcEndpoints(97,["http://127.0.0.1:34567"]);await wallet.settleScans();expect(watchers).toBe(2);expect(wallet.runningChains()).toEqual([97]);
  wallet.setNetworkEnabled(97,false);await wallet.settleScans();expect(wallet.runningChains()).toEqual([]);
  wallet.setNetworkEnabled(97,true);await wallet.settleScans();expect(wallet.runningChains()).toEqual([97]);expect(scans).toBe(3);
 });
 test("concurrent scan-now shares one admitted scan and stop awaits its completion",async()=>{
  let finish:((r:any)=>void)|undefined,calls=0;const registry=defaultRegistry();registry.setNetworkEnabled(84532,false);
  const dir=mkdtempSync(join(tmpdir(),"wallet-scan-"));const wallet=new Wallet({registry,store:new ChainStore(join(dir,"chain.sqlite")),credit:{} as any,makeWatcher:()=>({scan:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}} as any)});closers.push(()=>wallet.close());
  const a=wallet.scanNow(97),b=wallet.scanNow(97);await Promise.resolve();expect(calls).toBe(1);wallet.stop();let settled=false;const drain=wallet.settleScans().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);finish!({chainId:97});await Promise.all([a,b,drain]);expect(settled).toBe(true);
 });
});
