// Hostile transport: an unauthenticated frame header must never change session
// state. Sequence numbers are only trusted after the AEAD verifies the frame.

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { P2pLab } from "./support/p2p-lab.ts";
import { encodeFrame } from "../src/p2p/crypto.ts";
import { P2pError } from "../src/p2p/protocol.ts";

let lab: P2pLab | null = null;
afterEach(() => {
  lab?.close();
  lab = null;
});

function forgedFrame(seq: number, fill: number): Buffer {
  return encodeFrame({ type: "connection_request", seq, msgId: randomBytes(16), ciphertext: Buffer.alloc(32, fill) });
}

describe("unauthenticated frames", () => {
  test("a wild seq=1000 with all-zero ciphertext does not kill the session", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    await expect(lab.B.handleFrame(sessionId, forgedFrame(1000, 0))).rejects.toBeInstanceOf(P2pError);
    expect(lab.B.rejectedFrameCount(sessionId)).toBe(1);
    // The legitimate session must still work.
    await lab.sendRequest(sessionId);
    expect((await lab.B.listRequests()).length).toBe(1);
  });

  test("an unauthenticated old sequence is dropped, not treated as a replay", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    await lab.sendRequest(sessionId);
    await expect(lab.B.handleFrame(sessionId, forgedFrame(1, 7))).rejects.toBeInstanceOf(P2pError);
    expect(lab.B.rejectedFrameCount(sessionId)).toBe(1);
    await lab.sendRequest(sessionId, lab.requestDocument({ models: ["beta/y"] }));
    expect((await lab.B.listRequests()).length).toBe(2);
  });

  test("a byte-identical retransmission is served from the cache without closing", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    await lab.sendRequest(sessionId);
    const first = lab.sentFrames.find((f) => f.from === "A" && f.sessionId === sessionId);
    expect(first).toBeDefined();
    const again = await lab.B.handleFrame(sessionId, first!.frame);
    expect(again.duplicate).toBe(true);
    expect(lab.B.rejectedFrameCount(sessionId)).toBe(0);
    await lab.sendRequest(sessionId, lab.requestDocument({ models: ["beta/y"] }));
    expect((await lab.B.listRequests()).length).toBe(2);
  });
});
