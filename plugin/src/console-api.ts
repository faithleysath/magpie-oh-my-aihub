import { redact } from "./log.ts";
import { ConsoleInputError } from "./console-server.ts";
import { configureInput } from "./server.ts";
import { consoleWorkflows } from "./console-workflows.ts";
import { NETWORK_LOCAL_ACTIONS, consoleNetworkAction, consoleNetworkState } from "./console-network.ts";
import { WALLET_CONSOLE_ACTIONS, consoleWalletAction, consoleWalletState } from "./console-wallet.ts";
import { hex64, modelList, RequestValidationError } from "./connection-request.ts";
import type { Service } from "./service.ts";
import { controlAppFor } from "./control/app.ts";

/** Explicit browser product actions; no arbitrary path or CLI dispatch. */
export const CONSOLE_ACTIONS = [
  "join-network", "share-native-models", "stop-sharing", "network-refresh",
  "configure", "checks", "share-candidates", "share-models", "consume-toggle",
  "catalog-discover", "catalog-refresh", "catalog-settings", "trust-peer", "connection-request",
  "request-import", "request-approve", "request-reject", "key-reveal", "connection-import", "connection-preview", "catalog-connect",
  "provider-models", "provider-check", "provider-update-key", "provider-remove", "consumer-revoke", "consumer-models", "consumer-reissue", "consumer-check",
  "p2p-request", "p2p-quote-preview", "p2p-approve", "p2p-reject", "p2p-revoke", "p2p-recover",
  ...WALLET_CONSOLE_ACTIONS,
  ...NETWORK_LOCAL_ACTIONS,
] as const;
function clean<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => clean(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,clean(item)])) as T;
  return value;
}
export async function consoleState(service: Service) {
  const snapshot = service.consoleSnapshot();
  // Polling performs only local reads, never active probes.
  const workflows = consoleWorkflows(service).snapshot();
  const p2p = await controlAppFor(service)?.state() ?? null;
  return clean({
    schema: "ohmyaihub/console/1" as const, at: new Date().toISOString(), configured: Boolean(snapshot.config.nodeId),
    status: {
      plugin: { version: snapshot.plugin.version, startedAt: snapshot.plugin.startedAt, stateVersion: snapshot.plugin.stateVersion },
      magpie: snapshot.magpie, config: snapshot.config, easytier: snapshot.easytier, providers: snapshot.providers,
      // The read-only network projection (evidence times, stale markers, port
      // diagnostics) is the network page's data source; it was dropped from
      // this object, so the page silently fell back to raw config values.
      network: snapshot.network,
      catalog: snapshot.catalog, consumers: snapshot.consumers, accounting: snapshot.accounting,
      checks: snapshot.checks, checksAt: snapshot.checksAt, checksDurationMs: snapshot.checksDurationMs, readiness: snapshot.readiness,
      // The zero-file panel reads status.p2p; the control app's state object is
      // kept one level down so it can never overwrite the console schema.
      p2p,
    }, ...workflows, wallet: consoleWalletState(service), networkLocal: consoleNetworkState(service),
  });
}
const refuse = (message: string): never => { throw new ConsoleInputError(message); };
function fields(input: Record<string,unknown>, allowed: string[]): void {
  if (Object.keys(input).some(k => !allowed.includes(k))) refuse("unexpected action parameter");
}
function text(v: unknown, label: string, max=128): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) return refuse(`${label} must be non-empty text`);
  return v;
}
function bool(v: unknown): boolean { if (typeof v !== "boolean") return refuse("enabled must be true or false"); return v; }
function acceptance(input: Record<string,unknown>) {
  if (!hex64(input.fingerprint) || !hex64(input.quoteHash)) return refuse("review and accept the exact current fingerprint and quote first");
  return { fingerprint: input.fingerprint, quoteHash: input.quoteHash };
}
function key(v: unknown): string { return text(v,"Gateway Key",512); }
// These are known domain refusals, not arbitrary CLI stderr. Unknown failures
// stay uncertain (500 in the transport), so callers never blindly retry writes.
function knownRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /^(no (?:active consumer|remote provider|discovered catalogue peer)|configure this node first|consumption is disabled|choose |refusing |networkName must|networkSecret must|bad peer address|the (?:request|accepted|effective price|provider's catalogue identity|identity of|key of)|a shared model|consumer .+ (?:is paused|was revoked|has an unconfirmed|has no)|cannot reissue|this key is bound|pass the catalogue|.* is (?:first-seen|offline|unverified|stale);|.* offered an older|.* does not offer:)/.test(message);
}
export async function consoleAction(service: Service, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    if ((NETWORK_LOCAL_ACTIONS as readonly string[]).includes(name)) return consoleNetworkAction(service, name, input);
    if ((WALLET_CONSOLE_ACTIONS as readonly string[]).includes(name)) return consoleWalletAction(service, name, input);
    const w = () => consoleWorkflows(service);
    if (name.startsWith("p2p-")) {
      const app = controlAppFor(service);
      if (!app) throw new ConsoleInputError("the local P2P control service is not running", "not_running", 503);
      const p2p = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          if (/not found|no such|no active consumer|not in this/i.test(message)) throw new ConsoleInputError(message, "not_found", 404);
          if (/generation|stale|current|different quote|price|identity|fingerprint|changed/i.test(message)) throw new ConsoleInputError(message, "stale_or_conflict", 409);
          // A known lifecycle refusal, not an unknown outcome: one active
          // authorization per consumer; the operator must revoke it first.
          if (/already has an active approval|revoke it before/i.test(message)) throw new ConsoleInputError(message, "active_approval", 409);
          if (/tofu|untrusted|accept|trust/i.test(message)) throw new ConsoleInputError(message, "tofu_required", 403);
          if (/must|choose|required|invalid|list|amount|cap/i.test(message)) throw new ConsoleInputError(message, "invalid_input", 400);
          throw error;
        }
      };
      switch (name) {
        case "p2p-request":
          fields(input, ["nodeId", "fingerprint", "quoteHash", "models"]);
          return clean(await p2p(() => app.request(input)));
        case "p2p-quote-preview":
          fields(input, ["requestId", "models"]);
          return clean(await p2p(() => app.quotePreview(input)));
        case "p2p-approve":
          fields(input, ["requestId", "consumerFingerprint", "quoteHash", "priceVersion", "generation", "models", "capUsd", "acceptFingerprint"]);
          return clean(await p2p(() => app.approve(input)));
        case "p2p-reject":
          fields(input, ["requestId", "note"]);
          await p2p(() => app.reject(input));
          return { state: "rejected" };
        case "p2p-revoke":
          fields(input, ["approvalId"]);
          await p2p(() => app.revoke(input));
          return { state: "revoked" };
        case "p2p-recover":
          fields(input, ["approvalId"]);
          return clean(await p2p(() => app.recover(input)));
        default:
          return refuse("unsupported P2P operation");
      }
    }
    switch (name) {
      case "join-network": {
        fields(input,["networkName","networkSecret","initialNode"]);
        const networkName = text(input.networkName,"networkName",63);
        // Editing keeps the stored secret when the field is left blank; a first
        // join has no stored secret and the service refuses an empty one.
        let networkSecret: string | undefined;
        if (input.networkSecret !== undefined && input.networkSecret !== "") networkSecret = text(input.networkSecret,"networkSecret",256);
        let initialNode: string | null = null;
        if (input.initialNode !== undefined && input.initialNode !== null && input.initialNode !== "") {
          initialNode = text(input.initialNode,"initialNode",255).trim();
          if (!initialNode) return refuse("initialNode must be a peer address or empty");
        }
        await service.joinNetwork({ networkName, networkSecret, initialNode });
        return consoleState(service);
      }
      case "share-native-models": {
        fields(input,["models","confirm"]);
        if (input.confirm !== true) return refuse("sharing models requires the explicit confirmation (confirm: true)");
        await service.shareNativeModels({ models: modelList(input.models), confirm: true });
        return consoleState(service);
      }
      case "stop-sharing": {
        fields(input,["confirm"]);
        if (input.confirm !== true) return refuse("stopping sharing requires the explicit confirmation (confirm: true)");
        await service.stopSharing({ confirm: true });
        return consoleState(service);
      }
      case "network-refresh": {
        fields(input,[]);
        await service.refreshNetwork();
        return consoleState(service);
      }
      case "configure": {
        const parsed=configureInput(input); if(typeof parsed === "string") return refuse(parsed);
        // The public console may not turn sharing on with a wildcard allow list:
        // that would also share models added later without a new consent.
        if (Array.isArray(input.shareModels) && input.shareModels.some((m) => typeof m === "string" && m.includes("*"))) {
          return refuse("choose the exact native models with share-native-models; a wildcard shares future models without consent");
        }
        if (parsed.sharingEnabled === true && !parsed.shareModels && !service.config()?.share.models.length) {
          return refuse("sharing requires an explicit native model selection (share-native-models)");
        }
        await service.configure(parsed, { strictShareModels: true }); return consoleState(service);
      }
      case "checks": fields(input,[]); await service.checks(); return consoleState(service);
      case "share-candidates": fields(input,[]); return clean(await w().shareCandidates());
      case "share-models": {
        fields(input,["models"]);
        const models = modelList(input.models);
        if (models.some((m) => m.includes("*"))) return refuse("a wildcard shares future models without consent; choose exact native models");
        await service.setConsoleShareModels(models);
        return consoleState(service);
      }
      case "share-toggle": fields(input,["enabled"]); await service.setSharing(bool(input.enabled)); return consoleState(service);
      case "consume-toggle": fields(input,["enabled"]); await service.setConsuming(bool(input.enabled)); return consoleState(service);
      case "catalog-publish": fields(input,["enabled"]); await service.setCatalogPublishing(bool(input.enabled)); return consoleState(service);
      case "catalog-discover": fields(input,["enabled"]); await service.setCatalogDiscovery(bool(input.enabled)); return consoleState(service);
      case "catalog-refresh": fields(input,[]); return clean(await service.refreshCatalog());
      case "catalog-settings": {
        fields(input,["displayName","contact","minTopUpUsd"]);
        const options: {displayName?:string|null;contact?:string|null;minTopUpUsd?:number} = {};
        for(const k of ["displayName","contact"] as const) if(input[k] !== undefined) {
          const value=input[k]; if(value !== null && (typeof value !== "string" || value.length > 200 || /[\x00-\x1f]/.test(value))) return refuse(`${k} must be at most 200 characters`);
          options[k]=value as string|null;
        }
        if(input.minTopUpUsd !== undefined) { if(typeof input.minTopUpUsd !== "number" || !Number.isFinite(input.minTopUpUsd) || input.minTopUpUsd < .0001 || input.minTopUpUsd > 1_000_000) return refuse("minimum credit must be at least $0.0001 and at most $1000000"); options.minTopUpUsd=input.minTopUpUsd; }
        await service.setCatalogOptions(options); return consoleState(service);
      }
      case "trust-peer": {
        fields(input,["nodeId","fingerprint"]);
        if(!hex64(input.fingerprint)) return refuse("the exact fingerprint is required");
        const nodeId = text(input.nodeId,"nodeId");
        try {
          return clean(await service.trustCatalogPeer(nodeId,input.fingerprint));
        } catch (error) {
          // A node that shares no models has no catalogue entry; its signed
          // presence is pinned by the control plane instead.
          const message = String((error as Error)?.message ?? error);
          const app = controlAppFor(service);
          if (app && /no discovered catalogue peer/i.test(message)) return app.trustPresence(nodeId, input.fingerprint as string);
          throw error;
        }
      }
      case "connection-request": fields(input,["nodeId","models","fingerprint","quoteHash"]); return clean(service.catalogRequest(text(input.nodeId,"nodeId"),modelList(input.models),acceptance(input)));
      case "request-import": fields(input,["document"]); return clean(await w().importRequest(input.document));
      case "request-approve": fields(input,["requestId","capUsd","models"]); return clean(await w().approve(text(input.requestId,"requestId"),input.capUsd as number,modelList(input.models)));
      case "request-reject": fields(input,["requestId","note"]); return clean(await w().reject(text(input.requestId,"requestId"), input.note === undefined || input.note === "" ? "operator rejected" : text(input.note,"note",300)));
      case "key-reveal": fields(input,["consumerId"]); return w().reveal(text(input.consumerId,"consumerId")); // secret: intentionally not redacted, never cached by transport
      case "connection-import": fields(input,["document","key"]); return clean(await w().connect(input.document,input.key === undefined ? undefined : key(input.key)));
      case "connection-preview": {
        fields(input,["document"]); const preview=w().previewAuthorization(input.document); const {key: _secret,...document}=preview.document; return clean({nodeId:preview.nodeId,document});
      }
      case "catalog-connect": fields(input,["nodeId","key","fingerprint","quoteHash"]); return clean(await service.catalogConnect(text(input.nodeId,"nodeId"),key(input.key),{acceptance:acceptance(input)}));
      case "provider-models": fields(input,["id"]); return clean(await service.providerModels(text(input.id,"provider id")));
      case "provider-check": {
        fields(input,["id"]); const id=text(input.id,"provider id"); const providers=await service.reconcileProviders({only:id,verifyModels:true});
        return clean({provider:providers.find(p=>p.id===id), semantics:{missingOrWrongKey:401,spent:429,source:"native Magpie"}});
      }
      case "provider-update-key": fields(input,["id","key"]); return clean(await service.updateProvider(text(input.id,"provider id"),{key:key(input.key)}));
      case "provider-remove": fields(input,["id"]); return clean(await service.removeProvider(text(input.id,"provider id")));
      case "consumer-revoke": fields(input,["consumerId"]); return clean(await service.revokeConsumer(text(input.consumerId,"consumerId")));
      case "consumer-models": fields(input,["consumerId","models"]); return clean(await service.setConsumerModels(text(input.consumerId,"consumerId"),modelList(input.models)));
      case "consumer-reissue": {
        fields(input,["consumerId","acceptPriceVersion","acceptQuoteHash"]);
        for(const k of ["acceptPriceVersion","acceptQuoteHash"]) if(input[k] !== undefined && !hex64(input[k])) return refuse(`${k} must be an exact SHA-256 version`);
        return clean(await service.reissueConsoleConsumer(text(input.consumerId,"consumerId"),input.acceptPriceVersion as string|undefined,input.acceptQuoteHash as string|undefined));
      }
      case "consumer-check": fields(input,["consumerId"]); return clean(await service.checkConsoleConsumer(text(input.consumerId,"consumerId")));
      default: return refuse("unsupported console operation");
    }
  } catch(error) {
    if(error instanceof ConsoleInputError) throw error;
    if(error instanceof RequestValidationError || knownRefusal(error)) throw new ConsoleInputError((error as Error).message);
    throw error;
  }
}
