// A two-node lab with no sockets: two stores, two Catalogue identities, two
// P2pNode instances and an in-process "overlay" that moves sealed frames.
//
// Everything is in a temp directory and a fixed clock. The lab never resolves a
// LAN address, never opens a port and never reads the operator's Magpie state.
// It exists to test the core, not to claim a real two-host integration.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, loadOrCreateCatalogIdentity, sha256Hex } from "../../src/catalog.ts";
import { p2pIdentityFromCatalog, type P2pIdentity } from "../../src/p2p/identity.ts";
import { P2pStore } from "../../src/p2p/store.ts";
import {
  P2pNode,
  requestCorrelation,
  type P2pApprovalRequest,
  type P2pApprovalView,
  type P2pApprovedMaterials,
  type P2pBusinessPort,
  type P2pFrameResult,
  type P2pInboundApproval,
  type P2pRequestView,
  type P2pTakeAuthorizationInput,
  type P2pTransport,
} from "../../src/p2p/node.ts";
import type { P2pAuthorizationDocument, P2pPeerIdentity, P2pRequestDocument, P2pRevokeReason } from "../../src/p2p/protocol.ts";
import type { P2pHelloTarget } from "../../src/p2p/handshake.ts";

export const KEY = "sk-ohmy-" + "ab".repeat(32);
export const KEY_ID = "key-lab-1";
export const KEY_NAME = "ohmyaihub-bbbb2222";
export const QUOTE_HASH = "aa".repeat(32);
export const PRICE_VERSION = "bb".repeat(32);
export const KEY_HASH = sha256Hex(Buffer.from(KEY, "utf8"));

export interface LabFaults {
  failApprove?: boolean;
  failRegister?: boolean;
  failRevoke?: boolean;
  revokeUnconfirmed?: boolean;
  revokeVoid?: boolean;
  revokeWrongKey?: boolean;
  revokeWrongGeneration?: boolean;
  revokeCapRestricted?: boolean;
  revokeEnforcement?: string;
  narrowModels?: string[] | null;
  approveKeyId?: string;
  readbackModels?: string[] | null;
  readbackCapUsd?: number | null;
}

export class P2pLab {
  readonly dir: string;
  readonly clock = { now: new Date("2026-10-31T12:00:00.000Z") };
  readonly idA: ReturnType<typeof loadOrCreateCatalogIdentity>;
  readonly idB: ReturnType<typeof loadOrCreateCatalogIdentity>;
  readonly identityA: P2pIdentity;
  readonly identityB: P2pIdentity;
  storeA: P2pStore;
  storeB: P2pStore;
  A!: P2pNode;
  B!: P2pNode;
  readonly faults: LabFaults = {};
  readonly calls = {
    validate: 0,
    approve: 0,
    takeAuthorization: 0,
    register: 0,
    revoke: 0,
    recordRequest: 0,
    recordAck: 0,
    recordApproval: 0,
    drop: 0,
  };
  readonly importedApprovals: string[] = [];
  readonly sentFrames: Array<{ sessionId: string; from: "A" | "B"; frame: Buffer }> = [];
  readonly registeredSessions: Array<{ approvalId: string; providerNodeId: string; providerFingerprint: string }> = [];

  private constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "p2p-lab-"));
    mkdirSync(join(this.dir, "a"), { recursive: true });
    mkdirSync(join(this.dir, "b"), { recursive: true });
    const cwd = process.cwd();
    try {
      process.chdir(join(this.dir, "a"));
      this.idA = loadOrCreateCatalogIdentity();
      process.chdir(join(this.dir, "b"));
      this.idB = loadOrCreateCatalogIdentity();
    } finally {
      process.chdir(cwd);
    }
    this.identityA = p2pIdentityFromCatalog(this.idA, {
      nodeId: "aaaa1111",
      hostname: "ohmyaihub-aaaa1111",
      mappedCidr: null,
      controlPort: null,
      gatewayPort: null,
      catalogQuoteHash: null,
    });
    this.identityB = p2pIdentityFromCatalog(this.idB, {
      nodeId: "bbbb2222",
      hostname: "ohmyaihub-bbbb2222",
      mappedCidr: "10.66.1.2/32",
      controlPort: 3427,
      gatewayPort: 3425,
      catalogQuoteHash: QUOTE_HASH,
    });
    this.storeA = new P2pStore(join(this.dir, "a.sqlite"));
    this.storeB = new P2pStore(join(this.dir, "b.sqlite"));
    this.build();
  }

  static create(): P2pLab {
    return new P2pLab();
  }

  /** Rebuild the nodes over the same stores (restart simulation). */
  build(): void {
    const clock = () => new Date(this.clock.now.getTime());
    const transport = (self: "A" | "B"): P2pTransport => ({
      hello: async (target, hello) => {
        const targetNode = self === "A" ? this.B : this.A;
        const result = await targetNode.acceptHello(hello);
        return result.serverHello;
      },
      frame: async (session, frame) => {
        this.sentFrames.push({ sessionId: session.sessionId, from: self, frame: Buffer.from(frame) });
        const targetNode = self === "A" ? this.B : this.A;
        await targetNode.handleFrame(session.sessionId, frame);
      },
    });
    const port = this.port();
    this.A = new P2pNode({
      identity: this.identityA,
      store: this.storeA,
      port,
      transport: transport("A"),
      trust: () => "accepted",
      now: clock,
    });
    this.B = new P2pNode({
      identity: this.identityB,
      store: this.storeB,
      port,
      transport: transport("B"),
      now: clock,
    });
  }

  /** Simulates a crash: no graceful session close, only lost handles. */
  crash(): void {
    this.storeA.close();
    this.storeB.close();
    this.storeA = new P2pStore(join(this.dir, "a.sqlite"));
    this.storeB = new P2pStore(join(this.dir, "b.sqlite"));
    this.build();
  }

  restart(): void {
    try { this.A.close(); } catch { /* closed */ }
    try { this.B.close(); } catch { /* closed */ }
    // close() closed the SQLite handles too; reopen over the same files.
    this.storeA = new P2pStore(join(this.dir, "a.sqlite"));
    this.storeB = new P2pStore(join(this.dir, "b.sqlite"));
    this.build();
  }

  advance(ms: number): void {
    this.clock.now = new Date(this.clock.now.getTime() + ms);
  }

  target(): P2pHelloTarget {
    return {
      accountId: this.idB.summary.fingerprint,
      nodeId: "bbbb2222",
      fingerprint: this.idB.summary.fingerprint,
      mappedCidr: "10.66.1.2/32",
      controlPort: 3427,
      catalogQuoteHash: QUOTE_HASH,
    };
  }

  requestDocument(overrides: Partial<P2pRequestDocument> = {}): P2pRequestDocument {
    return {
      consumer: { nodeId: "aaaa1111", hostname: "ohmyaihub-aaaa1111" },
      provider: { nodeId: "bbbb2222", hostname: "ohmyaihub-bbbb2222", mappedCidr: "10.66.1.2/32", gatewayPort: 3425, catalogPort: 3426 },
      models: ["alpha/x"],
      quote: {
        contentHash: QUOTE_HASH,
        priceVersion: PRICE_VERSION,
        identityFingerprint: this.idB.summary.fingerprint,
        priceLocked: false,
      },
      acceptance: { fingerprint: this.idB.summary.fingerprint, quoteHash: QUOTE_HASH, priceVersion: PRICE_VERSION },
      ...overrides,
    };
  }

  private port(): P2pBusinessPort {
    const self = this;
    return {
      async providerContext() {
        return {
          nodeId: "bbbb2222",
          hostname: "ohmyaihub-bbbb2222",
          mappedCidr: "10.66.1.2/32",
          gatewayPort: 3425,
          catalogPort: 3426,
          sharing: "enabled" as const,
          quote: { contentHash: QUOTE_HASH, identityFingerprint: self.idB.summary.fingerprint, models: ["alpha/x", "beta/y"] },
        };
      },
      async validateRequest(input) {
        self.calls.validate += 1;
        const allowed = self.faults.narrowModels ?? input.request.models;
        return {
          models: allowed,
          quoteHash: input.request.quote.contentHash,
          priceVersion: input.request.quote.priceVersion,
          expiresAt: new Date(self.clock.now.getTime() + 10 * 60_000).toISOString(),
        };
      },
      async recordRequest() {
        self.calls.recordRequest += 1;
        return true;
      },
      async approve(input: P2pApprovalRequest): Promise<P2pApprovedMaterials> {
        self.calls.approve += 1;
        if (self.faults.failApprove) throw new Error("provisioner refused");
        return {
          approvalId: input.approvalId,
          generation: input.generation,
          consumerNodeId: input.consumer.nodeId,
          consumerFingerprint: input.consumer.fingerprint,
          models: input.models,
          capUsd: input.capUsd,
          quoteHash: input.quote.contentHash,
          // deliberately a DIFFERENT version from the request's full-set one
          priceVersion: sha256Hex(canonicalJson({ selected: input.models })).slice(0, 64),
          expiresAt: new Date(self.clock.now.getTime() + 10 * 60_000).toISOString(),
          keyId: self.faults.approveKeyId ?? KEY_ID,
          keyName: KEY_NAME,
          memo: input.memo,
        };
      },
      async takeAuthorization(input: P2pTakeAuthorizationInput): Promise<P2pAuthorizationDocument> {
        self.calls.takeAuthorization += 1;
        return {
          schema: "ohmyaihub.authorization/v2",
          createdAt: new Date(self.clock.now.getTime()).toISOString(),
          provider: { nodeId: "bbbb2222", mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
          consumer: { nodeId: input.consumerNodeId, fingerprint: input.consumerFingerprint },
          approvalId: input.approvalId,
          requestHash: input.requestHash,
          models: input.models,
          capUsd: input.capUsd,
          quote: {
            contentHash: input.quote.contentHash,
            identityFingerprint: input.quote.identityFingerprint,
            priceVersion: input.quote.priceVersion,
            priceLocked: false,
          },
          keyId: input.keyId,
          keyName: input.keyName,
          keyHash: KEY_HASH,
          key: KEY,
        };
      },
      async recordAck() {
        self.calls.recordAck += 1;
      },
      async revoke(input: { consumerNodeId: string; approvalId: string; keyId: string | null; generation: number; reason: P2pRevokeReason }) {
        self.calls.revoke += 1;
        if (self.faults.failRevoke) throw new Error("magpie did not confirm the key removal");
        if (self.faults.revokeVoid) return undefined as never;
        if (self.faults.revokeUnconfirmed || self.faults.revokeCapRestricted) {
          return {
            revoked: false as const,
            enforcement: self.faults.revokeCapRestricted ? ("capRestricted" as const) : ("none" as const),
            detail: "key still present",
          };
        }
        const approval = self.storeB.getApproval(input.approvalId);
        const keyId = input.keyId ?? approval?.keyId ?? "";
        if (self.faults.revokeWrongKey) {
          return {
            revoked: true as const,
            enforcement: "keyRevoked" as const,
            consumerNodeId: input.consumerNodeId,
            approvalId: input.approvalId,
            keyId: "some-other-key",
            generation: input.generation,
            detail: null,
          };
        }
        if (self.faults.revokeWrongGeneration) {
          return {
            revoked: true as const,
            enforcement: "keyRevoked" as const,
            consumerNodeId: input.consumerNodeId,
            approvalId: input.approvalId,
            keyId,
            generation: input.generation + 1,
            detail: null,
          };
        }
        return {
          revoked: true as const,
          enforcement: (self.faults.revokeEnforcement ?? "keyRevoked") as "keyRevoked" | "secretRotated",
          consumerNodeId: input.consumerNodeId,
          approvalId: input.approvalId,
          keyId,
          generation: input.generation,
          detail: null,
        };
      },
      async recordApproval() {
        self.calls.recordApproval += 1;
      },
      async importAuthorization(input: { document: P2pAuthorizationDocument; approval: P2pInboundApproval; session: { sessionId: string; peer: P2pPeerIdentity } }) {
        self.calls.register += 1;
        if (self.faults.failRegister) throw new Error("native registration failed");
        const models = self.faults.readbackModels ?? input.document.models;
        const capUsd = self.faults.readbackCapUsd ?? input.document.capUsd;
        self.importedApprovals.push(input.approval.approvalId);
        self.registeredSessions.push({
          approvalId: input.approval.approvalId,
          providerNodeId: input.session.peer.nodeId,
          providerFingerprint: input.session.peer.fingerprint,
        });
        return { keyId: input.document.keyId, models, capUsd };
      },
      async dropAuthorization(input: { approvalId: string; consumerNodeId: string; providerNodeId: string | null; providerFingerprint: string | null; reason: P2pRevokeReason }) {
        self.calls.drop += 1;
        self.registeredSessions.push({
          approvalId: input.approvalId,
          providerNodeId: input.providerNodeId ?? "",
          providerFingerprint: input.providerFingerprint ?? "",
        });
      },
    };
  }

  async establish(): Promise<string> {
    const { sessionId } = await this.A.openSession(this.target());
    return sessionId;
  }

  async sendRequest(sessionId: string, request = this.requestDocument()): Promise<{ requestHash: string; approvalId: null; state: "pending" }> {
    return this.A.requestConnection({ sessionId, request });
  }

  /** The full happy path up to `registered` (ACK still queued). */
  async deliver(approvalInput: { models: string[]; capUsd: number; memo?: string | null; acceptConsumer?: boolean } = { models: ["alpha/x"], capUsd: 2 }): Promise<{ sessionId: string; requestHash: string; approval: P2pApprovalView }> {
    const sessionId = await this.establish();
    const { requestHash } = await this.sendRequest(sessionId);
    const approval = await this.B.approve(requestHash, { ...approvalInput, acceptConsumer: approvalInput.acceptConsumer ?? true });
    return { sessionId, requestHash, approval };
  }

  async ack(sessionId: string): Promise<void> {
    await this.A.tick();
    void sessionId;
  }

  async views(): Promise<{ requests: P2pRequestView[]; approvals: P2pApprovalView[] }> {
    return { requests: await this.B.listRequests(), approvals: await this.B.listApprovals() };
  }

  async framesOf(node: "A" | "B"): Promise<P2pFrameResult[]> {
    void node;
    return [];
  }

  close(): void {
    try { this.A.close(); } catch { /* closed */ }
    try { this.B.close(); } catch { /* closed */ }
  }
}

export function requestCorrelationOf(requestHash: string): string {
  return requestCorrelation(requestHash);
}
