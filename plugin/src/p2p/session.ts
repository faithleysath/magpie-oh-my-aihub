// The B1 session transport: sequence numbers, AEAD frames, replay handling.
//
// A session is in-memory key material plus a persistent row that records only
// *metadata*: identities, transcript hash, and the last sequence in each
// direction. The keys are not written anywhere. A restart expires the row and
// both sides must handshake again; business recovery uses requestHash /
// approvalId, never the transport session.
//
// Replay rules (fail closed):
//   - seq must be exactly lastSeqIn + 1 for new traffic;
//   - an earlier seq is accepted only as an exact retransmission of the stored
//     frame (same msgId, same ciphertext) and returns the cached result;
//   - the same seq with a different msgId, the same msgId at another seq, or a
//     gap in the sequence closes the session;
//   - the same sealed frame replayed into a *different* session fails the AAD
//     and is rejected.

import { canonicalJson, sha256Hex } from "../catalog.ts";
import {
  decodeFrame,
  digestHex,
  encodeFrame,
  openFrame,
  receiveKey,
  sealFrame,
  sendKey,
  wipe,
} from "./crypto.ts";
import type { SessionMaterial } from "./handshake.ts";
import { fail, P2P_MAX_FRAME_BYTES, validateEnvelope, type P2pEnvelope, type P2pMessageType } from "./protocol.ts";
import type { P2pStore } from "./store.ts";

export interface OpenedInbound {
  seq: number;
  type: P2pMessageType;
  /** null on an exact retransmission: the cached result is the answer */
  envelope: P2pEnvelope | null;
  duplicate: boolean;
  cachedResultCode: string | null;
  cachedResultJson: string | null;
}

export interface EstablishSessionInput {
  material: SessionMaterial;
  store: P2pStore;
  now: () => Date;
}

export class P2pSession {
  private seqIn: number;
  private seqOut: number;
  private closed: string | null = null;
  /** frames dropped before AEAD authentication; a metric, never a close reason */
  private rejected = 0;

  private constructor(
    private readonly material: SessionMaterial,
    private readonly store: P2pStore,
    private readonly clock: () => Date,
    seqIn: number,
    seqOut: number,
  ) {
    this.seqIn = seqIn;
    this.seqOut = seqOut;
  }

  get sessionId(): string {
    return this.material.sessionId;
  }
  get role(): "consumer" | "provider" {
    return this.material.role;
  }
  get peer() {
    return this.material.peer;
  }
  get self() {
    return this.material.self;
  }
  get expiresAt(): string {
    return this.material.expiresAt;
  }
  get transcriptHash(): string {
    return this.material.transcriptHash;
  }
  get lastSeqIn(): number {
    return this.seqIn;
  }
  get lastSeqOut(): number {
    return this.seqOut;
  }
  /** the session's authorization-sealing key; never serialise it */
  get authorizationKey(): Buffer {
    return this.material.keys.authorization;
  }
  get catalogQuoteHash(): string | null {
    return this.material.catalogQuoteHash;
  }
  get closedReason(): string | null {
    return this.closed;
  }
  get rejectedFrames(): number {
    return this.rejected;
  }

  /** Persists the session row (metadata only) and opens the transport. */
  static establish(input: EstablishSessionInput): P2pSession {
    const { material, store, now } = input;
    const at = now();
    const existing = store.getSession(material.sessionId);
    if (existing) {
      if (existing.transcriptHash !== material.transcriptHash) fail("replay", "this session id already carries another transcript");
      if (existing.state !== "open") fail("session_closed", `the session is ${existing.state}`);
      return new P2pSession(material, store, now, existing.lastSeqIn, existing.lastSeqOut);
    }
    if (store.tombstone("session", material.sessionId)) fail("replay", "this session id was already used and closed");
    store.createSession({
      sessionId: material.sessionId,
      role: material.role,
      peer: material.peerTarget,
      transcriptHash: material.transcriptHash,
      catalogQuoteHash: material.catalogQuoteHash,
      now: at,
      expiresAt: material.expiresAt,
    });
    return new P2pSession(material, store, now, 0, 0);
  }

  /** Re-opens the transport for a live process (e.g. after a hello retry). */
  static resume(input: EstablishSessionInput): P2pSession {
    const { material, store, now } = input;
    const row = store.getSession(material.sessionId);
    if (!row) fail("session_closed", "the session row is missing; handshake again");
    if (row.state !== "open") fail("session_closed", `the session is ${row.state}; handshake again`);
    if (row.transcriptHash !== material.transcriptHash) fail("replay", "the transcript hash does not match the stored session");
    if (row.peerFingerprint !== material.peer.fingerprint) fail("stale_identity", "the session peer identity changed");
    if (now().getTime() > Date.parse(row.expiresAt)) fail("expired", "the session has expired");
    return new P2pSession(material, store, now, row.lastSeqIn, row.lastSeqOut);
  }

  private assertUsable(): void {
    if (this.closed) fail("session_closed", `the session is closed (${this.closed})`);
    if (this.clock().getTime() > Date.parse(this.material.expiresAt)) {
      this.shutdown("expired");
      fail("expired", "the session has expired; handshake again");
    }
  }

  private direction(): "c2s" | "s2c" {
    return this.role === "consumer" ? "c2s" : "s2c";
  }

  /**
   * Encrypts and frames an already-signed envelope. The envelope id is the
   * frame id, so the transport and the signature cover the same handle.
   */
  seal(envelope: P2pEnvelope): Buffer {
    this.assertUsable();
    if (envelope.from.fingerprint !== this.material.self.fingerprint) fail("stale_identity", "the envelope is not signed by this session's local identity");
    if (envelope.to.fingerprint !== this.material.peer.fingerprint) fail("target_mismatch", "the envelope targets another peer");
    if (envelope.from.nodeId !== this.material.self.nodeId || envelope.to.nodeId !== this.material.peer.nodeId) {
      fail("target_mismatch", "the envelope node ids do not match the session");
    }
    const seq = this.seqOut + 1;
    const msgId = Buffer.from(envelope.id, "hex");
    const plaintext = Buffer.from(canonicalJson(envelope), "utf8");
    const key = sendKey(this.material.keys, this.role);
    const direction = this.direction();
    const { ciphertext } = sealFrame(key, { sessionId: this.sessionId, direction, seq, msgId: envelope.id, type: envelope.type, plaintext });
    const frame = encodeFrame({ type: envelope.type, seq, msgId, ciphertext });
    const frameHash = digestHex(ciphertext);
    const bodyHash = sha256Hex(canonicalJson(envelope.body));
    const at = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.bumpSeqOut(this.sessionId, seq, this.clock());
      this.store.recordOutbound({ sessionId: this.sessionId, seq, msgId: envelope.id, type: envelope.type, frameHash, bodyHash, at });
    })();
    this.seqOut = seq;
    return frame;
  }

  /**
   * Authenticates, decrypts and de-frames one inbound frame. A duplicate frame
   * returns the cached result; everything else either returns the envelope or
   * closes the session.
   */
  open(raw: Buffer): OpenedInbound {
    this.assertUsable();
    const frame = decodeFrame(raw, P2P_MAX_FRAME_BYTES);
    const msgIdHex = frame.msgId.toString("hex");
    const direction = this.direction() === "c2s" ? "s2c" : "c2s";
    const receive = receiveKey(this.material.keys, this.role);

    const frameHash = digestHex(frame.ciphertext);
    // Sequence numbers are an unauthenticated header field. A forged/odd header
    // must never kill a legitimate session; only an AEAD-verified frame may.
    if (frame.seq <= this.seqIn) {
      const known = this.store.inboundBySeq(this.sessionId, frame.seq);
      if (known && known.direction === "in" && known.msgId === msgIdHex && known.frameHash === frameHash) {
        return { seq: frame.seq, type: frame.type, envelope: null, duplicate: true, cachedResultCode: known.resultCode, cachedResultJson: known.resultJson };
      }
      if (!this.authenticatedAt(frame, receive, direction)) {
        this.rejected += 1;
        return fail("replay", "an unauthenticated old frame was ignored");
      }
      this.shutdown("authenticated replay");
      return fail("replay", "an authenticated old frame was replayed");
    }
    if (frame.seq !== this.seqIn + 1) {
      if (!this.authenticatedAt(frame, receive, direction)) {
        this.rejected += 1;
        return fail("replay", "an unauthenticated sequence gap was ignored");
      }
      this.shutdown("authenticated sequence gap");
      return fail("replay", "an authenticated frame skipped a sequence");
    }

    let plaintext: Buffer;
    try {
      plaintext = openFrame(receive, {
        sessionId: this.sessionId,
        direction,
        seq: frame.seq,
        msgId: msgIdHex,
        type: frame.type,
        ciphertext: frame.ciphertext,
      });
    } catch (e) {
      // Unauthenticated garbage: reject the frame, keep the real session open.
      // Rate limiting belongs to the HTTP layer (B-service).
      this.rejected += 1;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      this.shutdown("bad envelope json");
      return fail("malformed", "the frame did not decrypt to JSON");
    } finally {
      plaintext.fill(0);
    }
    if (this.store.inboundByMsgId(this.sessionId, msgIdHex)) {
      this.shutdown("message id reuse");
      return fail("replay", "this message id was already used in the session");
    }
    let verified: ReturnType<typeof validateEnvelope>;
    try {
      verified = validateEnvelope(parsed, {
        now: this.clock(),
        expectedFrom: { nodeId: this.material.peer.nodeId, fingerprint: this.material.peer.fingerprint },
        expectedTo: { nodeId: this.material.self.nodeId, fingerprint: this.material.self.fingerprint },
      });
    } catch (e) {
      // The frame authenticated, so the peer really sent an invalid envelope.
      this.shutdown("invalid authenticated envelope");
      throw e;
    }
    if (verified.envelope.id !== msgIdHex) {
      this.shutdown("id mismatch");
      return fail("malformed", "the envelope id does not match the frame id");
    }
    if (verified.envelope.type !== frame.type) {
      this.shutdown("type mismatch");
      return fail("malformed", "the frame type does not match the signed envelope type");
    }
    const bodyHash = verified.bodyHash;
    const at = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.bumpSeqIn(this.sessionId, frame.seq, this.clock());
      this.store.recordInbound({ sessionId: this.sessionId, seq: frame.seq, msgId: msgIdHex, type: frame.type, frameHash, bodyHash, at });
    })();
    this.seqIn = frame.seq;
    return { seq: frame.seq, type: frame.type, envelope: verified.envelope, duplicate: false, cachedResultCode: null, cachedResultJson: null };
  }

  /** Decrypts a frame at a claimed sequence purely to prove the peer sent it. */
  private authenticatedAt(frame: { seq: number; msgId: Buffer; type: P2pMessageType; ciphertext: Buffer }, key: Buffer, direction: "c2s" | "s2c"): boolean {
    let plaintext: Buffer;
    try {
      plaintext = openFrame(key, {
        sessionId: this.sessionId,
        direction,
        seq: frame.seq,
        msgId: frame.msgId.toString("hex"),
        type: frame.type,
        ciphertext: frame.ciphertext,
      });
    } catch {
      return false;
    }
    plaintext.fill(0);
    return true;
  }

  /** Stores the business result for an inbound sequence (sensitive-safe). */
  finish(seq: number, resultCode: string, resultJson: string | null = null): void {
    this.store.finishInbound(this.sessionId, seq, resultCode, resultJson, this.clock());
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    wipe(this.material.keys.c2s);
    wipe(this.material.keys.s2c);
    wipe(this.material.keys.authorization);
    this.store.closeSession(this.sessionId, reason, this.clock());
  }

  /** Graceful close. The peer's next frame fails; business state survives. */
  close(reason = "closed by operator"): void {
    this.shutdown(reason);
  }
}

/** The type is re-exported for callers that build frames directly in tests. */
export type { P2pMessageType };
