// Shared validation for the CLI and browser's out-of-band request workflow.
// Importing a request conveys no authority: the provider compares it with its
// current signed quote again when a human approves it.
import { catalogPriceVersion } from "./pricing.ts";
import { CATALOG_MAX_MODELS, isValidModelId, isValidMappedCidr } from "./catalog.ts";

export class RequestValidationError extends Error {}
export interface ConnectionRequest {
  schema: "ohmyaihub.connection-request/v1";
  createdAt?: string;
  consumer: { nodeId: string; hostname?: string };
  provider: { nodeId: string; hostname?: string; mappedCidr: string; gatewayPort: number };
  models: string[];
  quote: { contentHash: string; priceVersion: string; identityFingerprint: string; priceLocked: false };
  acceptance: { fingerprint: string; quoteHash: string; priceVersion?: string };
  approval: { action: "consumers add"; consumerId: string; models: string[]; capUsd?: number; quoteHash: string; quotePriceVersion: string };
}
export interface ApprovalContext {
  provider: { nodeId: string | null; mappedCidr: string | null; gatewayPort: number };
  quote: { contentHash: string; identity: { fingerprint: string } | null; models: { id: string; pricing: unknown }[] } | null;
}
function fail(message: string): never { throw new RequestValidationError(message); }
export const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function object(v: unknown): Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
}
function id(v: unknown): v is string { return typeof v === "string" && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(v); }
export function modelList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > CATALOG_MAX_MODELS || v.some(m => !isValidModelId(m)) || new Set(v).size !== v.length) {
    fail("choose a non-empty list of distinct provider/model ids");
  }
  return [...v];
}
export function capOnGrid(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0.0001 || v > 1_000_000) fail("the cap must be a positive number of at least $0.0001 and at most $1000000");
  if (Math.abs(Math.round(v * 1e4) / 1e4 - v) > 1e-9) fail("the cap must be on Magpie's $0.0001 cap grid");
  return v;
}
export function boundedDocument(raw: unknown): void {
  let text: string;
  try { text = JSON.stringify(raw); } catch { return fail("document must be JSON"); }
  if (!text || Buffer.byteLength(text) > 48 * 1024) fail("document exceeds the 48 KiB limit");
}
export function validateConnectionRequest(raw: unknown): ConnectionRequest {
  boundedDocument(raw);
  const r = object(raw), consumer = object(r.consumer), provider = object(r.provider), q = object(r.quote), a = object(r.approval), accept = object(r.acceptance);
  if (r.schema !== "ohmyaihub.connection-request/v1") fail("not an ohmyaihub.connection-request/v1 document");
  if (!id(consumer.nodeId)) fail("the request has no valid consumer.nodeId");
  if (!id(provider.nodeId)) fail("the request has no valid provider.nodeId");
  if (!isValidMappedCidr(provider.mappedCidr)) fail("the request has no valid mapped provider address");
  if (!Number.isInteger(provider.gatewayPort) || provider.gatewayPort < 1 || provider.gatewayPort > 65535) fail("the request has no valid gateway port");
  const models = modelList(r.models);
  if (a.action !== "consumers add") fail("the request has no `approval.action = consumers add` block");
  if (a.consumerId !== consumer.nodeId) fail("the approval consumerId does not match the request's consumer");
  if (!Array.isArray(a.models) || a.models.length !== models.length || a.models.some((m: unknown) => typeof m !== "string" || !models.includes(m)) || new Set(a.models).size !== models.length) fail("the approval models do not match the request models");
  if (!hex64(q.contentHash) || !hex64(q.priceVersion)) fail("the request quote must carry a 64-hex content hash and price version");
  if (!hex64(q.identityFingerprint)) fail("the request quote must carry a 64-hex identity fingerprint");
  if (accept.fingerprint !== q.identityFingerprint || accept.quoteHash !== q.contentHash) fail("the request acceptance does not match its quote fingerprint/hash");
  if (accept.priceVersion !== undefined && accept.priceVersion !== q.priceVersion) fail("the request acceptance price version does not match its quote");
  if (a.quoteHash !== q.contentHash || a.quotePriceVersion !== q.priceVersion) fail("the approval quote binding does not match the request quote");
  const label = (v: unknown) => typeof v === "string" && v.length <= 128 ? v : undefined;
  return {
    schema: r.schema,
    ...(typeof r.createdAt === "string" && r.createdAt.length <= 40 ? { createdAt: r.createdAt } : {}),
    consumer: { nodeId: consumer.nodeId, ...(label(consumer.hostname) ? { hostname: consumer.hostname } : {}) },
    provider: { nodeId: provider.nodeId, mappedCidr: provider.mappedCidr, gatewayPort: provider.gatewayPort, ...(label(provider.hostname) ? { hostname: provider.hostname } : {}) },
    models,
    quote: { contentHash: q.contentHash, priceVersion: q.priceVersion, identityFingerprint: q.identityFingerprint, priceLocked: false },
    acceptance: { fingerprint: accept.fingerprint, quoteHash: accept.quoteHash, ...(accept.priceVersion ? { priceVersion: accept.priceVersion } : {}) },
    approval: { action: a.action, consumerId: a.consumerId, models: [...models], ...(typeof a.capUsd === "number" && Number.isFinite(a.capUsd) ? { capUsd: a.capUsd } : {}), quoteHash: a.quoteHash, quotePriceVersion: a.quotePriceVersion },
  };
}

export function validateRequestApproval(request: ConnectionRequest, context: ApprovalContext, selected: string[] = request.models): { models: string[]; priceVersion: string } {
  const { provider, quote } = context;
  if (provider.nodeId !== request.provider.nodeId) fail("this request is for another provider, not this node");
  if (provider.mappedCidr !== request.provider.mappedCidr) fail("this request targets a different mapped provider address");
  if (provider.gatewayPort !== request.provider.gatewayPort) fail("this request targets a different gateway port");
  if (!quote) fail("this provider has no published catalogue to verify the accepted quote against; publish it first");
  if (quote.contentHash !== request.quote.contentHash) fail("the request's accepted quote is not the current published quote; ask the consumer to re-read it");
  if (quote.identity?.fingerprint !== request.quote.identityFingerprint) fail("the request's accepted catalogue identity is not this node's current identity");
  if (request.models.some(m => !quote.models.some(q => q.id === m))) fail("the request names a model this provider's current quote does not offer");
  const requestedPrice = catalogPriceVersion(quote.models.filter(m => request.models.includes(m.id)));
  if (!requestedPrice || requestedPrice !== request.quote.priceVersion) fail("the request's accepted price version does not match this node's current quote for those models");
  const models = modelList(selected);
  if (models.some(m => !request.models.includes(m))) fail("approved models must be a subset of the request");
  const priceVersion = catalogPriceVersion(quote.models.filter(m => models.includes(m.id)));
  if (!priceVersion) fail("a selected model has no complete price");
  return { models, priceVersion };
}
