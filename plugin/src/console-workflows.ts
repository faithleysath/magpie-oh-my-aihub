import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import { canonicalJson } from "./catalog.ts";
import { catalogPriceVersion } from "./pricing.ts";
import { boundedDocument, capOnGrid, hex64, modelList, object, RequestValidationError, validateConnectionRequest, validateRequestApproval, type ConnectionRequest } from "./connection-request.ts";
import type { Service, ShareCandidatesView } from "./service.ts";

export interface RequestRecord {
  id: string;
  status: "pending" | "approved" | "rejected";
  importedAt: string;
  updatedAt: string;
  document: ConnectionRequest;
  approvedModels?: string[];
  capUsd?: number;
  note?: string;
}
export interface RequestView extends RequestRecord {
  eligible: boolean;
  reasons: string[];
  currentQuote: { contentHash: string; identityFingerprint: string; priceVersion: string | null } | null;
}
export interface AuthorizationDocument {
  schema: "ohmyaihub.authorization/v1";
  createdAt: string;
  provider: { nodeId: string; hostname?: string; mappedCidr: string; gatewayPort: number };
  consumer: { nodeId: string };
  models: string[];
  quote: { contentHash: string; identityFingerprint: string; priceVersion: string; priceLocked: false };
  capUsd: number;
  key: string;
}
const bad = (message: string): never => { throw new RequestValidationError(message); };
const digest = (document: ConnectionRequest) => createHash("sha256").update(canonicalJson(document)).digest("hex");
const instances = new WeakMap<Service, ConsoleWorkflows>();
export function consoleWorkflows(service: Service): ConsoleWorkflows {
  let value = instances.get(service);
  if (!value) { value = new ConsoleWorkflows(service); instances.set(service, value); }
  return value;
}

/** Request journal only. It contains no keys, balance or accounting decisions. */
export class ConsoleWorkflows {
  private queue: Promise<unknown> = Promise.resolve();
  private candidates: ShareCandidatesView | null = null;
  private candidatesAt: string | null = null;
  constructor(private service: Service, private file = statePath("console-requests.json")) {}

  private load(): RequestRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      if (statSync(this.file).size > 8 * 1024 * 1024) return bad("request history is unavailable; restore a valid backup through recovery before retrying");
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw.version !== 1 || !Array.isArray(raw.requests) || raw.requests.length > 200) throw new Error();
      const records: RequestRecord[] = raw.requests.map((r: any) => {
        const document = validateConnectionRequest(r.document);
        if (r.id !== digest(document) || !["pending", "approved", "rejected"].includes(r.status) || typeof r.importedAt !== "string" || typeof r.updatedAt !== "string") throw new Error();
        return { id: r.id, status: r.status, importedAt: r.importedAt, updatedAt: r.updatedAt, document,
          ...(r.approvedModels ? { approvedModels: modelList(r.approvedModels) } : {}),
          ...(r.capUsd !== undefined ? { capUsd: capOnGrid(r.capUsd) } : {}),
          ...(typeof r.note === "string" ? { note: r.note.slice(0, 300) } : {}) };
      });
      if (new Set(records.map(r => r.id)).size !== records.length) throw new Error();
      return records;
    } catch { return bad("request history is unavailable; restore a valid backup through recovery before retrying"); }
  }
  private save(requests: RequestRecord[]): void { writeJsonAtomic(this.file, { version: 1, requests }, 0o600); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run;
  }
  private view(record: RequestRecord): RequestView {
    const context = this.service.requestApprovalContext();
    const reasons: string[] = [];
    try { validateRequestApproval(record.document, context); }
    catch (e) { reasons.push(e instanceof RequestValidationError ? e.message : "current quote cannot be verified"); }
    if (record.status !== "pending") reasons.push(`request is already ${record.status}`);
    return { ...structuredClone(record), eligible: reasons.length === 0, reasons,
      currentQuote: context.quote ? { contentHash: context.quote.contentHash, identityFingerprint: context.quote.identity?.fingerprint ?? "", priceVersion: catalogPriceVersion(context.quote.models.filter(m => record.document.models.includes(m.id))) } : null };
  }
  snapshot() {
    return { workflows: { requests: this.load().map(r => this.view(r)) }, shareCandidates: this.candidates, shareCandidatesAt: this.candidatesAt };
  }
  async shareCandidates() {
    this.candidates = await this.service.shareCandidates();
    this.candidatesAt = new Date().toISOString();
    return this.candidates;
  }
  importRequest(raw: unknown): Promise<RequestView> {
    const document = validateConnectionRequest(raw);
    return this.serial(async () => {
      const records = this.load(), id = digest(document), found = records.find(r => r.id === id);
      if (found) return this.view(found);
      if (records.length >= 200) return bad("request journal is full");
      const now = new Date().toISOString();
      const record: RequestRecord = { id, status: "pending", importedAt: now, updatedAt: now, document };
      records.push(record); this.save(records); return this.view(record);
    });
  }
  approve(requestId: string, capUsd: number, selected: string[]): Promise<RequestView> {
    capOnGrid(capUsd); const models = modelList(selected);
    return this.serial(async () => {
      const records = this.load(), record = records.find(r => r.id === requestId);
      if (!record) return bad("request was not found; import it first");
      if (record.status === "rejected") return bad("the request was rejected");
      if (record.status === "approved") {
        if (record.capUsd !== capUsd || canonicalJson([...(record.approvedModels ?? [])].sort()) !== canonicalJson([...models].sort())) return bad("this request was already approved with different models or cap");
        return this.view(record);
      }
      await this.service.approveConnectionRequest(record.document, models, capUsd);
      record.status = "approved"; record.capUsd = capUsd; record.approvedModels = [...models]; record.updatedAt = new Date().toISOString();
      this.save(records); return this.view(record);
    });
  }
  reject(requestId: string, note: string): Promise<RequestView> {
    return this.serial(async () => {
      const records = this.load(), record = records.find(r => r.id === requestId);
      if (!record) return bad("request was not found");
      if (record.status === "approved") return bad("an approved request cannot be rejected; revoke the consumer explicitly");
      record.status = "rejected"; record.note = note; record.updatedAt = new Date().toISOString(); this.save(records); return this.view(record);
    });
  }
  async reveal(consumerId: string): Promise<AuthorizationDocument> {
    const handover = await this.service.handover(consumerId);
    if (!handover.models.length) return bad("the key has no scoped model authorization");
    const context = this.service.requestApprovalContext();
    const currentQuote = context.quote;
    const version = currentQuote && handover.models.every(id => currentQuote.models.some(m => m.id === id))
      ? catalogPriceVersion(currentQuote.models.filter(m => handover.models.includes(m.id))) : null;
    const consumer = this.service.provisioner.find(consumerId);
    if (!currentQuote?.identity || !version || consumer?.acceptedQuoteHash !== currentQuote.contentHash || consumer.priceVersion !== version) return bad("the key's current price binding differs; review and reissue before handover");
    return { schema: "ohmyaihub.authorization/v1", createdAt: new Date().toISOString(), provider: { nodeId: context.provider.nodeId!, mappedCidr: context.provider.mappedCidr!, gatewayPort: context.provider.gatewayPort }, consumer: { nodeId: consumerId }, models: handover.models,
      quote: { contentHash: currentQuote.contentHash, identityFingerprint: currentQuote.identity.fingerprint, priceVersion: version, priceLocked: false }, capUsd: handover.capUsd, key: handover.key };
  }
  previewAuthorization(raw: unknown, keyOverride?: string): { document: AuthorizationDocument; nodeId: string } {
    boundedDocument(raw);
    const r = object(raw), p = object(r.provider), c = object(r.consumer), q = object(r.quote);
    if (r.schema !== "ohmyaihub.authorization/v1") return bad("not an ohmyaihub.authorization/v1 document");
    if (c.nodeId !== this.service.config()?.nodeId) return bad("this authorization belongs to another consumer node");
    const models = modelList(r.models);
    if (!hex64(q.contentHash) || !hex64(q.identityFingerprint) || !hex64(q.priceVersion)) return bad("authorization has no complete quote binding");
    const peer = this.service.peersInDirectory().find(peer => peer.nodeId === p.nodeId);
    if (!peer || !peer.quote || !peer.identity || !peer.online || !["verified", "connected"].includes(peer.status)) return bad("discover and explicitly trust this provider before importing its authorization");
    if (peer.identity.fingerprint !== q.identityFingerprint || peer.quoteHash !== q.contentHash || peer.mappedCidr !== p.mappedCidr || peer.quote.node.gatewayPort !== p.gatewayPort) return bad("authorization identity, address or quote differs from the current trusted provider");
    if (models.some(m => !peer.quote!.models.some(q => q.id === m)) || catalogPriceVersion(peer.quote.models.filter(m => models.includes(m.id))) !== q.priceVersion) return bad("authorization models or price version differ from the current quote");
    const key = keyOverride ?? r.key;
    if (typeof key !== "string" || key.length < 8 || key.length > 512 || /[\s\x00-\x1f]/.test(key)) return bad("authorization needs a valid Gateway Key");
    return { nodeId: p.nodeId, document: { schema: r.schema, createdAt: typeof r.createdAt === "string" ? r.createdAt : "", provider: { nodeId: p.nodeId, mappedCidr: p.mappedCidr, gatewayPort: p.gatewayPort }, consumer: { nodeId: c.nodeId }, models, quote: { contentHash: q.contentHash, identityFingerprint: q.identityFingerprint, priceVersion: q.priceVersion, priceLocked: false }, capUsd: capOnGrid(r.capUsd), key } };
  }
  async connect(raw: unknown, keyOverride?: string) {
    const { document, nodeId } = this.previewAuthorization(raw, keyOverride);
    return this.service.catalogConnect(nodeId, document.key, { models: document.models, acceptance: { fingerprint: document.quote.identityFingerprint, quoteHash: document.quote.contentHash, priceVersion: document.quote.priceVersion } });
  }
}
