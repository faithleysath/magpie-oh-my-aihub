import { afterEach, describe, expect, test } from "bun:test";
import { P2pLab, KEY_ID } from "./support/p2p-lab.ts";

let lab: P2pLab | null = null;
afterEach(() => { lab?.close(); lab = null; });

describe("authenticated pull/poll", () => {
  test("consumer polls its approved sealed delivery without a reverse endpoint and registers before ACK", async () => {
    lab = P2pLab.create();
    lab.faults.disableProviderPush = true;
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    const approval = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true });
    expect(approval.state).not.toBe("rejected");
    // No provider push occurred; the consumer pulls a fresh authenticated hello.
    expect(lab.calls.register).toBe(0);
    // canPush is false for the provider, so approve left the rows pending
    // instead of exhausting them to dead.
    const results = await lab.A.poll(lab.target());
    expect(results.length).toBeGreaterThanOrEqual(2); // approved + delivery
    expect(lab.calls.recordApproval).toBe(1);
    expect(lab.calls.register).toBe(1);
    // Registration happened before ACK; poll's normal tick then sends the ACK.
    const consumer = await lab.A.approvalView(approval.approvalId);
    expect(consumer?.state).toBe("delivered");
    expect(consumer?.keyId).toBe(KEY_ID);
    expect(lab.calls.recordAck).toBe(1);
    expect((await lab.B.approvalView(approval.approvalId))?.ackState).toBe("acked");
    // A captured poll hello cannot be replayed to drain a fresh outbox.
    const captured = lab.pollHellos.at(-1);
    await expect(lab.B.acceptHello(captured, { rejectReplay: true })).rejects.toThrow(/replay/);
  });
});
