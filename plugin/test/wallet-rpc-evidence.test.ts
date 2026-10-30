import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "../src/wallet.ts";
import { ChainStore } from "../src/chainstore.ts";
import { defaultRegistry } from "../src/networks.ts";
import { createLab, ensureConsumer, RECIPIENT } from "./support/wallet-lab.ts";
import { TEST_PAYER } from "./support/signer.ts";
import { walletView } from "../src/walletview.ts";

const close:(()=>void)[]=[];
afterEach(()=>{for(const fn of close.splice(0))fn();});
function setup(health:()=>Promise<any>,scan:()=>Promise<any>){
 const registry=defaultRegistry();registry.setNetworkEnabled(84532,false);
 const store=new ChainStore(join(mkdtempSync(join(tmpdir(),"wallet-rpc-evidence-")),"chain.sqlite"));
 const wallet=new Wallet({registry,store,credit:{} as any,makeWatcher:()=>({health,scan}) as any});
 close.push(()=>wallet.close());
 return {wallet,store};
}
const measured={chainId:97,head:139_000_000,finalizedBlock:138_999_999,lastError:null,endpoints:[{url:"https://old-rpc.invalid",ok:true}],assets:[]};

test("gateway evidence follows ledger wallclock even when simulated chain clock is behind",async()=>{
 const lab=createLab();close.push(()=>lab.close());
 // Historical fixture clock controls intent expiry, not the time a direct
 // gateway measurement actually completed. This fails independently of noon.
 lab.clock.at=new Date(Date.now()-3600_000);
 await ensureConsumer(lab,"alice");
 const request=lab.request({consumerId:"alice",chainId:97,amountRaw:"1000000"});
 lab.sign(request.intent.invoiceId,request.digest);
 lab.chainFor(97).transfer({from:TEST_PAYER,to:RECIPIENT,amount:1000000n});lab.chainFor(97).mineN(20);
 await lab.scan(97);
 const evidence=await lab.viewInput(),readback=evidence.readbacks!.alice!;
 const applied=evidence.deposits!.alice!.find(d=>d.source.startsWith("chain:"))!;
 expect(readback.at>=applied.appliedAt!).toBe(true);
 expect(walletView(evidence).deposits[0]!.keyUsable).toBe(true);
 // Production chronology must still refuse genuinely older measurements.
 const stale={...evidence,readbacks:{alice:{...readback,at:lab.clock.at.toISOString()}}};
 expect(walletView(stale).deposits[0]!.keyUsable).toBe(false);
 expect(walletView(stale).deposits[0]!.keyUsableReason).toContain("predates");
});

test("RPC replacement invalidates endpoint measurements but preserves durable scan progress",async()=>{
 const {wallet,store}=setup(async()=>measured,async()=>({chainId:97,errors:["old endpoint error"]}));
 const timestamp="2026-10-30T10:00:00.000Z";
 store.advanceCursor({chainId:97,block:138_000_000,blockHash:null,at:timestamp});
 await wallet.health();await wallet.scanNow(97);
 expect(wallet.statusLocal().chains.find(c=>c.chainId===97)?.head).toBe(measured.head);
 expect(wallet.lastScanResult(97)).not.toBeNull();
 wallet.setRpcEndpoints(97,["http://127.0.0.1:34567"]);
 const fresh=wallet.statusLocal().chains.find(c=>c.chainId===97)!;
 expect(fresh.head).toBeNull();expect(fresh.finalizedBlock).toBeNull();expect(fresh.endpoints).toEqual([]);
 expect(fresh.cursor).toBe(138_000_000);expect(fresh.lastScanAt).toBe(timestamp);
 expect(wallet.lastScanResult(97)).toBeNull();expect(wallet.runningChains()).toEqual([]);
});

test("old in-flight probe and scan cannot repopulate evidence after RPC replacement",async()=>{
 let finishHealth:((v:any)=>void)|undefined,finishScan:((v:any)=>void)|undefined;
 const {wallet}=setup(()=>new Promise(resolve=>{finishHealth=resolve;}),()=>new Promise(resolve=>{finishScan=resolve;}));
 const health=wallet.health(),scan=wallet.scanNow(97);
 await Promise.resolve();
 wallet.setRpcEndpoints(97,["http://127.0.0.1:34568"]);
 finishHealth!(measured);finishScan!({chainId:97,errors:["old transport error"]});
 await Promise.all([health,scan]);
 const fresh=wallet.statusLocal().chains.find(c=>c.chainId===97)!;
 expect(fresh.head).toBeNull();expect(fresh.finalizedBlock).toBeNull();expect(fresh.endpoints).toEqual([]);
 expect(wallet.lastScanResult(97)).toBeNull();
});
