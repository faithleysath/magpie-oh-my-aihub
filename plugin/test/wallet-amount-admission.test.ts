import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConsoleWallet } from "../src/console-wallet.ts";
import { previewDepositDocument, externalSignatureDocument } from "../src/wallet-workflows.ts";
import { signDigest, TEST_PAYER } from "./support/signer.ts";
import { formatTokenAmount } from "../src/walletamount.ts";
import { createLab, ensureConsumer, PROVIDER_ID } from "./support/wallet-lab.ts";
import type { Service } from "../src/service.ts";

const closers: (()=>void)[]=[];
afterEach(()=>{for(const close of closers.splice(0))close();});
async function setup() {
  const lab=createLab();closers.push(()=>lab.close());await ensureConsumer(lab);
  const service={config:()=>({nodeId:PROVIDER_ID}),provisioner:lab.provisioner,ledger:lab.ledger,
    consoleWalletModule:()=>lab.wallet,walletForConfiguration:()=>lab.wallet,
    accountingStatus:()=>({uncertain:false,lastCheckAt:null,serving:true,uncertainReason:null})} as unknown as Service;
  const file=join(lab.dir,"operations-admission.json");
  const adapter=new ConsoleWallet(service,file,lab.nowMs);
  const input={consumerId:"alice",chainId:84532,assetId:lab.assetFor(84532).assetId,amount:"1",ttlSec:3600};
  return {lab,service,adapter,input,file};
}
const requestId="11111111-1111-4111-8111-111111111111";
describe("numeric admission precedes durable wallet intent reservation",()=>{
  test("uint256 overflow and unsafe nano-USD amounts cannot reserve an operation or create an invoice",async()=>{
    const {lab,service,adapter,input,file}=await setup();
    for(const amount of ["9".repeat(90),"9007199.254740992"]) {
      await expect(adapter.action("wallet-intent-preview",{...input,amount})).rejects.toThrow(/范围/);
      await expect(adapter.action("wallet-intent-create",{...input,amount,requestId,previewHash:"a".repeat(64)})).rejects.toThrow(/范围/);
      expect(existsSync(file)).toBe(false);
      expect(lab.wallet.intents()).toHaveLength(0);
    }
    // A new host and the same operation UUID can make a valid request: the
    // known-invalid input never left a permanent uncertainty tombstone.
    const reopened=new ConsoleWallet(service,file,lab.nowMs);
    const {preview}=await reopened.action("wallet-intent-preview",input);
    const created=await reopened.action("wallet-intent-create",{...input,requestId,previewHash:preview.previewHash});
    expect(created.document.amount.raw).toBe("1000000000000000000");
    expect(lab.wallet.intents()).toHaveLength(1);
  });
  test("safe nano-USD boundary remains exact and the first unsafe value is refused",async()=>{
    const {adapter,input}=await setup();
    const {preview}=await adapter.action("wallet-intent-preview",{...input,amount:"9007199.254740991"});
    expect(preview.estimatedUsd).toBe(Number.MAX_SAFE_INTEGER/1e9);
    expect(preview.amountRaw).toBe("9007199254740991000000000");
    await expect(adapter.action("wallet-intent-preview",{...input,amount:"9007199.254740992"})).rejects.toThrow(/安全记账范围/);
  });
  test("imported signing fields and payer cannot drift from the exact typed data",async()=>{
    const {adapter,input,lab}=await setup();
    const {preview}=await adapter.action("wallet-intent-preview",input);
    const {document}=await adapter.action("wallet-intent-create",{...input,requestId,previewHash:preview.previewHash});
    const variants=[
      {...document,chainId:97},
      {...document,typedData:{...document.typedData,domain:{...document.typedData.domain,chainId:97}}},
      {...document,typedData:{...document.typedData,domain:{...document.typedData.domain,name:"another-domain"}}},
      {...document,asset:{...document.asset,contractAddress:"0x"+"12".repeat(20)}},
      {...document,recipientAddress:"0x"+"12".repeat(20)},
      {...document,digest:"0x"+"12".repeat(32)},
    ];
    for(const changed of variants) expect(()=>previewDepositDocument(changed,"alice",new Date(lab.clock.at))).toThrow();
    expect(()=>externalSignatureDocument(document,signDigest(document.digest),"0x"+"12".repeat(20),"alice",new Date(lab.clock.at))).toThrow(/不匹配/);
    expect(externalSignatureDocument(document,signDigest(document.digest),TEST_PAYER,"alice",new Date(lab.clock.at)).verified).toBe(true);
  });
  test("imported signing documents refuse uint256 overflow as a known validation error",async()=>{
    const {adapter,input,lab}=await setup();
    const {preview}=await adapter.action("wallet-intent-preview",input);
    const {document}=await adapter.action("wallet-intent-create",{...input,requestId,previewHash:preview.previewHash});
    const amountRaw=(1n<<256n).toString();
    const invalid={...document,amount:{raw:amountRaw,tokens:formatTokenAmount(amountRaw,18)},typedData:{...document.typedData,message:{...document.typedData.message,expectedAmountRaw:amountRaw}}};
    expect(()=>previewDepositDocument(invalid,"alice",new Date(lab.clock.at))).toThrow(/uint256/);
  });
});
