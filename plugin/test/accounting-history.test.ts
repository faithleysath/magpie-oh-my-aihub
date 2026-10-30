import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger, LedgerHistoryCursorError } from "../src/ledger.ts";
import { priceSnapshot } from "../src/pricing.ts";
import { ConsoleWallet } from "../src/console-wallet.ts";
import type { Service } from "../src/service.ts";

const dispose:(()=>void)[]=[];
afterEach(()=>{for(const fn of dispose.splice(0))fn();});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"accounting-history-")),ledger=new Ledger(join(dir,"ledger.sqlite"));
 dispose.push(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 const snapshot=priceSnapshot([{id:"native/model",price:{input:1,output:2,cache_read:.1,cache_write:.2}}],["native/model"])!;
 const open=(consumerId:string,keyId:string)=>ledger.ensureAccount({consumerId,keyId,keyName:consumerId,price:snapshot,windowSpec:"3650d",startAt:"2026-10-30T00:00:00.000Z",resetAt:"2036-10-27T00:00:00.000Z",openingNanos:10_000_000_000,capNanos:10_000_000_000});
 const alice=open("alice","private-fixture-key-id"),bob=open("bob","other-fixture-key-id");
 const log=join(dir,"private-source-log.jsonl");
 const lines=Array.from({length:123},(_,i)=>JSON.stringify({t:"2026-10-30T01:00:00.000Z",callerKeyId:alice.keyId,provider:"native",model:i===122?"unpriced":"model",in:i+1,out:2,cache_read:3,cache_write:4,cache_write_1h:5,status:200}));
 lines.push(JSON.stringify({t:"2026-10-30T02:00:00.000Z",callerKeyId:bob.keyId,provider:"native",model:"model",in:9999,out:999,status:200}));
 writeFileSync(log,lines.join("\n")+"\n");
 ledger.importUsage({consumerId:"alice",window:alice,logPath:log});ledger.importUsage({consumerId:"bob",window:bob,logPath:log});
 return {ledger,alice,bob,dir,snapshot};
}

test("consumer keyset history has fixed 50-row pages, stable timestamp ties and no other consumer/source/key fields",()=>{
 const {ledger,alice,dir}=fixture();const before=ledger.balance("alice");
 const first=ledger.consumptionHistory("alice");expect(first.rows).toHaveLength(50);expect(first.nextCursor).toBeString();
 const second=ledger.consumptionHistory("alice",first.nextCursor!);expect(second.rows).toHaveLength(50);
 const third=ledger.consumptionHistory("alice",second.nextCursor!);expect(third.rows).toHaveLength(23);expect(third.nextCursor).toBeNull();
 const all=[...first.rows,...second.rows,...third.rows];expect(new Set(all.map(r=>r.id)).size).toBe(123);
 expect(all.every(r=>r.windowId===alice.id)).toBe(true);expect(all.some(r=>!r.priceVerified&&r.amountNanos===0)).toBe(true);
 expect(all.find(r=>r.priceVerified)?.tokens.cacheWrite1h).toBe(5);
 expect(ledger.consumptionHistory("bob").rows).toHaveLength(1);
 const text=JSON.stringify(first);for(const forbidden of [dir,"private-fixture-key-id","source","key_id","private-source-log"])expect(text).not.toContain(forbidden);
 expect(ledger.balance("alice")).toEqual(before);
 expect(ledger.consumptionHistory("alice").rows).toEqual(first.rows);
});

test("history cursor is opaque, authenticated, consumer bound and malformed input never reaches SQL",()=>{
 const {ledger}=fixture();const cursor=ledger.consumptionHistory("alice").nextCursor!;
 expect(()=>ledger.consumptionHistory("bob",cursor)).toThrow(LedgerHistoryCursorError);
 for(const invalid of ["", "' OR 1=1 --", "a".repeat(2049),cursor.slice(0,-1)+(cursor.endsWith("a")?"b":"a"),Buffer.from(JSON.stringify({consumerId:"alice",recordedAt:"x",id:"x"})).toString("base64url")])expect(()=>ledger.consumptionHistory("alice",invalid)).toThrow(LedgerHistoryCursorError);
 expect(Buffer.from(cursor,"base64url").toString()).not.toContain("alice");
});

test("history preserves frozen cost and price version after a new current price/window, including zero unpriced records",()=>{
 const {ledger,snapshot}=fixture();const recorded=ledger.consumptionHistory("alice").rows;
 const window=ledger.openWindowFor("alice")!;ledger.closeWindow(window.id,"fixture new price");
 const changed=priceSnapshot([{id:"native/model",price:{input:100,output:200,cache_read:10,cache_write:20}}],["native/model"])!;
 ledger.openWindow({consumerId:"alice",keyId:"new-private-key",keyName:"alice",price:changed,windowSpec:"3650d",startAt:"2026-10-30T03:00:00.000Z",resetAt:"2036-10-27T00:00:00.000Z",capNanos:10_000_000_000});
 expect(ledger.consumptionHistory("alice").rows).toEqual(recorded);expect(recorded.every(r=>r.priceVersion===snapshot.version)).toBe(true);
});

test("console history authorizes actual managed consumer and returns safe cursor refusals without reconciliation",async()=>{
 const {ledger}=fixture();let reconciles=0;
 const service={ledger,provisioner:{all:()=>[{consumerId:"alice"}],refreshAll:()=>{reconciles++;throw new Error("must not reconcile");}}} as unknown as Service;
 const console=new ConsoleWallet(service);
 const page=await console.action("accounting-history",{consumerId:"alice"});expect(page.rows).toHaveLength(50);
 await expect(console.action("accounting-history",{consumerId:"bob"})).rejects.toThrow(/实际管理/);
 await expect(console.action("accounting-history",{consumerId:"alice",cursor:"bad-cursor"})).rejects.toThrow(/分页/);
 await expect(console.action("accounting-history",{consumerId:"alice",limit:9999})).rejects.toThrow(/字段/);
 expect(reconciles).toBe(0);
});
