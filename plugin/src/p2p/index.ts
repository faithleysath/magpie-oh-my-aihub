// Public B1 surface. B-service imports from here and nowhere else inside
// `plugin/src/p2p/`; the wire format, crypto and state machine stay core-owned.
//
// Exported on purpose: the node facade, its narrow ports, the identity binding,
// the persistent store and the protocol types a port signature needs. Not
// exported: session key material, frame sealing, raw handshake construction and
// the store's SQL — callers get behaviour, not primitives to recombine.

export { P2pNode, expectedIdempotency } from "./node.ts";
export type {
  P2pNodeOptions,
  P2pBusinessPort,
  P2pTransport,
  P2pTrustLookup,
  P2pFrameResult,
  P2pTickResult,
  P2pRequestView,
  P2pApprovalView,
  P2pPeerView,
  P2pProviderContext,
  P2pRecordedRequest,
  P2pApprovalRequest,
  P2pApprovedMaterials,
  P2pApprovalReconcileInput,
  P2pApprovalReconcile,
  P2pTakeAuthorizationInput,
  P2pAckRecord,
  P2pRevokeRequest,
  P2pRevokeOutcome,
  P2pRevokeConfirmed,
  P2pRevokeRefused,
  P2pRevokeEnforcement,
  P2pInboundApproval,
  P2pResultCode,
} from "./node.ts";

export { p2pIdentityFromCatalog, catalogProviderTrust, trustVerdict, peerOf } from "./identity.ts";
export type { P2pIdentity, P2pLocalBinding, P2pTrustVerdict, P2pTrustRecordLike } from "./identity.ts";

export { P2pStore, DEFAULT_P2P_RETRY, retryDelayMs, nextAttemptAt } from "./store.ts";
export type {
  P2pRetryPolicy,
  P2pPeerTrustRow,
  P2pSessionRow,
  P2pRequestRow,
  P2pApprovalRow,
  P2pDeliveryRow,
  P2pOutboxRow,
  P2pInboxRow,
  P2pRecoveryReport,
  P2pApprovalState,
  P2pDeliveryState,
  P2pRequestState,
} from "./store.ts";

export { P2pError } from "./protocol.ts";
export type {
  P2pErrorCode,
  P2pMessageType,
  P2pPeerIdentity,
  P2pTargetIdentity,
  P2pEnvelope,
  P2pRequestDocument,
  P2pAuthorizationDocument,
  P2pRejectionReason,
  P2pRevokeReason,
  P2pStatusBody,
} from "./protocol.ts";
export { P2P_PROTOCOL, P2P_VERSION, P2P_MESSAGE_TYPES, P2P_B1_UNSUPPORTED, P2P_MAX_TTL_MS, P2P_CLOCK_SKEW_MS, P2P_MAX_FRAME_BYTES, P2P_HANDSHAKE_MAX_BYTES } from "./protocol.ts";
export type { P2pHelloTarget } from "./handshake.ts";
