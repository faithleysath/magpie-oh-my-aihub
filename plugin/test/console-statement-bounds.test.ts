import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConsoleWallet } from "../src/console-wallet.ts";
import { buildStatement, verifyStatement } from "../src/walletstatement.ts";
import { boundedWalletDocument } from "../src/wallet-workflows.ts";
import { createLab, ensureConsumer, PROVIDER_ID } from "./support/wallet-lab.ts";
import type { Service } from "../src/service.ts";

const closers:(()=>void)[]=[];
afterEach(()=>{for(const close of closers.splice(0))close();});
async function fixture(count:number) {
  const lab=createLab();closers.push(()=>lab.close());await ensureConsumer(lab);
  for(let n=0;n<count;n++) lab.request({consumerId:"alice",chainId:84532,amountRaw:String(n+1)});
  const consumer=lab.views().find(c=>c.consumerId==="alice")!;
  const statement=buildStatement({providerId:PROVIDER_ID,consumerId:"alice",generatedAt:new Date().toISOString(),
    networks:lab.wallet.networks(),assets:lab.wallet.allAssets(),intents:lab.store.intentsFor("alice",1000),events:[],
    deposits:lab.ledger.depositsFor("alice"),consumer,accounting:{state:"unknown",reason:null,openSettlements:0}});
  let nodeId=PROVIDER_ID;
  const service={config:()=>({nodeId}),provisioner:lab.provisioner,ledger:lab.ledger,
    consoleWalletModule:()=>lab.wallet,walletForConfiguration:()=>lab.wallet,
    accountingStatus:()=>({uncertain:false,lastCheckAt:null,serving:false,uncertainReason:null}),
    walletStatement:async()=>statement} as unknown as Service;
  return {adapter:new ConsoleWallet(service,join(lab.dir,"operations.json"),lab.nowMs),statement,consumerNode(){nodeId="alice";}};
}
describe("private statement export/import share one bound",()=>{
  test("a valid statement above 32 KiB round-trips through the named consumer import",async()=>{
    const {adapter,statement,consumerNode}=await fixture(140);
    expect(Buffer.byteLength(JSON.stringify(statement))).toBeGreaterThan(40*1024);
    expect(Buffer.byteLength(JSON.stringify(statement))).toBeLessThan(48*1024);
    expect(verifyStatement(statement).ok).toBe(true);
    const exported=await adapter.action("wallet-statement",{consumerId:"alice"});
    consumerNode();
    const imported=await adapter.action("wallet-statement-preview",{document:exported.statement});
    expect(imported.digestVerified).toBe(true);
    expect(imported.statement.statement.consumerId).toBe("alice");
    expect(imported.statement.statement.requests).toHaveLength(140);
    expect(Buffer.byteLength(JSON.stringify({document:exported.statement}))).toBeLessThan(64*1024);
  });
  test("oversized statement refuses both directions without a misleading successful export",async()=>{
    const {adapter,statement,consumerNode}=await fixture(180);
    expect(Buffer.byteLength(JSON.stringify(statement))).toBeGreaterThan(48*1024);
    await expect(adapter.action("wallet-statement",{consumerId:"alice"})).rejects.toThrow(/48 KiB/);
    consumerNode();
    await expect(adapter.action("wallet-statement-preview",{document:statement})).rejects.toThrow(/48 KiB/);
  });
  test("larger private statement allowance does not widen signature or deposit-document bounds",()=>{
    expect(()=>boundedWalletDocument({value:"x".repeat(33*1024)})).toThrow(/32 KiB/);
  });
});
