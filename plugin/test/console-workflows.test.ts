import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConsoleWorkflows } from "../src/console-workflows.ts";
import { RequestValidationError, validateConnectionRequest, validateRequestApproval } from "../src/connection-request.ts";
import { catalogPriceVersion, priceSnapshot } from "../src/pricing.ts";
import { Service } from "../src/service.ts";
import { FakeMagpie, LAB_MODEL, LAB_PRICE } from "./support/fake-magpie.ts";
import { consoleAction, CONSOLE_ACTIONS } from "../src/console-api.ts";
import { ConsoleInputError } from "../src/console-server.ts";
import { saveCatalogTrust, fingerprintOf, keyIdOf } from "../src/catalog.ts";

const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const FP = fingerprintOf(PUBLIC_KEY), HASH = "b".repeat(64), NODE = "d".repeat(16);
const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const models = [{id:LAB_MODEL,pricing:price},{id:"lab/other",pricing:price}];
function context() { return {provider:{nodeId:NODE,mappedCidr:"10.66.1.2/32",gatewayPort:3425},quote:{contentHash:HASH,identity:{fingerprint:FP},models:structuredClone(models)}}; }
function request() {
  const version=catalogPriceVersion(models)!;
  return {schema:"ohmyaihub.connection-request/v1",consumer:{nodeId:"alice"},provider:{nodeId:NODE,mappedCidr:"10.66.1.2/32",gatewayPort:3425},models:models.map(m=>m.id),quote:{contentHash:HASH,priceVersion:version,identityFingerprint:FP},acceptance:{fingerprint:FP,quoteHash:HASH,priceVersion:version},approval:{action:"consumers add",consumerId:"alice",models:models.map(m=>m.id),quoteHash:HASH,quotePriceVersion:version}};
}
function directoryPeer() {
  return {nodeId:NODE,online:true,status:"verified",mappedCidr:"10.66.1.2/32",identity:{fingerprint:FP},quoteHash:HASH,quote:{node:{gatewayPort:3425},models}} as any;
}

describe("connection request trust and price binding",()=>{
  test("normalized request strips extraneous secrets and subset price version is computed from exactly approved models",()=>{
    const r=validateConnectionRequest({...request(),secret:"must-not-persist",consumer:{nodeId:"alice",secret:"must-not-persist"}});
    expect(JSON.stringify(r)).not.toContain("must-not-persist");
    const chosen=validateRequestApproval(r,context(),[LAB_MODEL]);
    expect(chosen.priceVersion).toBe(catalogPriceVersion([models[0]!])!);
    expect(chosen.priceVersion).not.toBe(r.quote.priceVersion);
    expect(()=>validateRequestApproval(r,context(),["lab/unrequested"])).toThrow(/subset/);
    const stale=context();stale.quote.contentHash="c".repeat(64);
    expect(()=>validateRequestApproval(r,stale)).toThrow(/current published quote/);
    const unpriced=context();unpriced.quote.models[0]!.pricing=null as never;
    expect(()=>validateRequestApproval(r,unpriced)).toThrow(/price version/);
  });
  test("bad shapes, oversized imports, duplicate/empty models and nested bindings are refused",()=>{
    for(const raw of [null,{}, {...request(),models:[]},{...request(),models:[LAB_MODEL,LAB_MODEL]},{...request(),approval:{...request().approval,consumerId:"bob"}}, {...request(),quote:{...request().quote,identityFingerprint:"x"}}, {...request(),extra:"x".repeat(49*1024)}]) {
      expect(()=>validateConnectionRequest(raw)).toThrow(RequestValidationError);
    }
  });
});

describe("local request journal",()=>{
  test("import is idempotent without issuing a key; restart retains approval and never stores a key",async()=>{
    const dir=mkdtempSync("/tmp/console-journal-"),file=join(dir,"private","requests.json");
    let approvals=0;
    const svc={requestApprovalContext:context,approveConnectionRequest:async()=>{approvals++;return {};}} as unknown as Service;
    const w=new ConsoleWorkflows(svc,file);
    const first=await w.importRequest(request());
    expect(first.status).toBe("pending"); expect(first.eligible).toBe(true);expect(approvals).toBe(0);
    expect((await w.importRequest(request())).id).toBe(first.id);
    expect(w.snapshot().workflows.requests).toHaveLength(1);
    const approved=await w.approve(first.id,1,[LAB_MODEL]);expect(approved.status).toBe("approved");expect(approvals).toBe(1);
    await w.approve(first.id,1,[LAB_MODEL]);expect(approvals).toBe(1);
    expect(new ConsoleWorkflows(svc,file).snapshot().workflows.requests[0]!.status).toBe("approved");
    expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(join(dir,"private")).mode&0o777).toBe(0o700);
    expect(readFileSync(file,"utf8")).not.toContain('"key"');
    await expect(w.approve(first.id,2,[LAB_MODEL])).rejects.toThrow(/different/);
    await expect(w.reject(first.id,"reject")).rejects.toThrow(/revoke/);
  });
  test("corrupt history fails closed; rejected request cannot issue",async()=>{
    const dir=mkdtempSync("/tmp/console-journal-"),file=join(dir,"requests.json");
    const svc={requestApprovalContext:context,approveConnectionRequest:async()=>{throw new Error("must not issue")}} as unknown as Service;
    const w=new ConsoleWorkflows(svc,file),r=await w.importRequest(request());
    await w.reject(r.id,"declined"); await expect(w.approve(r.id,1,[LAB_MODEL])).rejects.toThrow(/rejected/);
    writeFileSync(file,"{bad");expect(()=>w.snapshot()).toThrow(/unavailable/);
    await expect(w.importRequest(request())).rejects.toThrow(/unavailable/);
  });
});

describe("authorization handover and import",()=>{
  function fixture() {
    process.chdir(mkdtempSync("/tmp/console-auth-trust-"));
    saveCatalogTrust({ [NODE]: {nodeId:NODE,accepted:true,fingerprint:FP,publicKey:PUBLIC_KEY,keyId:keyIdOf(PUBLIC_KEY),overlayHostname:`ohmyaihub-${NODE}`,firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),quoteVersion:1,quoteHash:HASH,pending:null} });
    let current=context();let consumer={acceptedQuoteHash:HASH,priceVersion:catalogPriceVersion([models[0]!])};let connects=0;
    const svc={requestApprovalContext:()=>current,config:()=>({nodeId:"alice"}),handover:async()=>({consumerId:"alice",models:[LAB_MODEL],capUsd:1,key:"fixture-authorization-secret"}),provisioner:{find:()=>consumer},peersInDirectory:()=>[directoryPeer()],catalogConnect:async()=>{connects++;return {id:"peer-one"};}} as unknown as Service;
    return {svc,setCurrent(v:any){current=v},setConsumer(v:any){consumer=v},get connects(){return connects}};
  }
  test("managed CLI consumer has no journal dependency; unaccepted quote refuses; explicit post-price reissue allows fresh handover",async()=>{
    const f=fixture(),w=new ConsoleWorkflows(f.svc,join(mkdtempSync("/tmp/handover-"),"missing.json"));
    const initial=await w.reveal("alice");expect(initial.schema).toBe("ohmyaihub.authorization/v1");expect(initial.key).toBe("fixture-authorization-secret");
    const changed=context();changed.quote.contentHash="c".repeat(64);changed.quote.models[0]!.pricing.input=3;f.setCurrent(changed);
    await expect(w.reveal("alice")).rejects.toThrow(/price binding/);
    f.setConsumer({acceptedQuoteHash:changed.quote.contentHash,priceVersion:catalogPriceVersion([changed.quote.models[0]!])});
    const after=await w.reveal("alice");expect(after.quote.contentHash).toBe(changed.quote.contentHash);expect(after.quote.priceVersion).not.toBe(initial.quote.priceVersion);
    f.setConsumer({acceptedQuoteHash:null,priceVersion:after.quote.priceVersion});await expect(w.reveal("alice")).rejects.toThrow(/price binding/);
  });
  test("import binds consumer, locally trusted identity, exact quote and priced models before connect",async()=>{
    const f=fixture(),w=new ConsoleWorkflows(f.svc,join(mkdtempSync("/tmp/handover-"),"missing.json"));
    const doc=await w.reveal("alice");await w.connect(doc);expect(f.connects).toBe(1);
    for(const changed of [{...doc,consumer:{nodeId:"bob"}},{...doc,quote:{...doc.quote,contentHash:"c".repeat(64)}},{...doc,models:["lab/unrequested"]},{...doc,provider:{...doc.provider,gatewayPort:9999}}]) {
      await expect(w.connect(changed)).rejects.toThrow(RequestValidationError);
    }
    (f.svc as any).peersInDirectory=()=>[{...directoryPeer(),status:"unverified"}];
    await expect(w.connect(doc)).rejects.toThrow(/explicitly trust/);expect(f.connects).toBe(1);
  });
});

function realService() {
  process.chdir(mkdtempSync("/tmp/console-service-"));
  const magpie=new FakeMagpie();
  (magpie as any).providersReadable=()=>true;
  const metas=()=>[LAB_MODEL,"lab/other"].map(id=>({id,price:LAB_PRICE,displayName:null,gatewayApis:["chat"],nativeApis:null,contextWindow:null,maxOutputTokens:null,images:null,modalities:null,reasoningLevels:null,priceSource:"magpie-settings",capabilitiesSource:"magpie-settings"}));
  (magpie as any).catalogModels=async()=>metas();
  const svc=new Service({magpie:magpie as never,magpieVersion:"fixture",probes:{catalogModels:async()=>metas() as any}});
  (svc as any).state.config={nodeId:NODE,share:{models:["*"]},sharingEnabled:true,mappedCidr:"10.66.1.2/32"};
  (svc as any).publishCatalogNow=async()=>{};
  svc.requestApprovalContext=context;
  svc.writeSnapshot=()=>{};
  return {svc,magpie};
}
describe("actual service and provisioner approval",()=>{
  test("partial approval creates exactly one priced, capped key and no implicit extra credit",async()=>{
    const {svc,magpie}=realService(),r=validateConnectionRequest(request());
    const approved=await svc.approveConnectionRequest(r,[LAB_MODEL],1);
    expect(approved.models).toEqual([LAB_MODEL]);expect(approved.priceVersion).toBe(priceSnapshot([{id:LAB_MODEL,price:LAB_PRICE}],[LAB_MODEL])!.version);
    expect(approved.acceptedQuoteHash).toBe(HASH);expect(approved.capUsd).toBe(1);expect(magpie.keys.size).toBe(1);
    await svc.approveConnectionRequest(r,[LAB_MODEL],1);expect(magpie.keys.size).toBe(1);
    await expect(svc.approveConnectionRequest(r,[LAB_MODEL],2)).rejects.toThrow(/different authorization/);
    expect(svc.ledger?.balance("alice").depositedNanos).toBe(1_000_000_000);
  });
  test("quote changes during awaited native-price read are refused before first key mutation",async()=>{
    const {svc,magpie}=realService(),r=validateConnectionRequest(request());let changed=false;
    svc.requestApprovalContext=()=>{const ctx=context();if(changed)ctx.quote.contentHash="c".repeat(64);return ctx};
    const original=magpie.catalogModels.bind(magpie);
    magpie.catalogModels=async()=>{changed=true;return original()};
    await expect(svc.approveConnectionRequest(r,[LAB_MODEL],1)).rejects.toThrow(/current published quote/);
    expect(magpie.keys.size).toBe(0);
  });
  test("unpriced model share and widening consumer scope are refused",async()=>{
    const {svc}=realService();await svc.approveConnectionRequest(validateConnectionRequest(request()),[LAB_MODEL],1);
    await expect(svc.setConsumerModels("alice",["lab/other"])).rejects.toThrow(/narrow/);
    await expect(svc.setConsoleShareModels(["remote/nope"])).rejects.toThrow(/native models/);
    await expect(svc.setConsumerModels("alice",[])).rejects.toThrow(/non-empty/);
  });
});

describe("console action allowlist and safe failures",()=>{
  test("workflow operations are explicit and malformed input never reaches business writes",async()=>{
    expect(CONSOLE_ACTIONS).toContain("key-reveal");expect(CONSOLE_ACTIONS).not.toContain("topup" as never);
    const {svc}=realService();
    for(const [name,input] of [["share-toggle",{enabled:"false"}],["request-approve",{requestId:"x",capUsd:0,models:[LAB_MODEL]}],["consumer-models",{consumerId:"alice",models:[]}],["trust-peer",{nodeId:NODE,fingerprint:"wrong"}],["catalog-settings",{minTopUpUsd:0}],["provider-remove",{id:"peer",exec:"shell"}]] as [string,Record<string,unknown>][]) {
      await expect(consoleAction(svc,name,input)).rejects.toBeInstanceOf(ConsoleInputError);
    }
  });
});
