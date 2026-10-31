// Advanced, local-only recovery for a legacy chain deposit whose asset id was
// not stored by an older build.
//
// It is deliberately not a UI/P2P action and it never invents a chain row. The
// caller must supply the local ChainStore event identity; this module reads the
// store and requires the original claimed invoice, tx/log, token, amount,
// recipient, payer and consumer to agree before it fills only the missing asset
// metadata. A row with unknown provenance cannot use this path: it can only be
// reviewed manually as manual/simulated (without fabricating chain evidence).
//
// No amount, source, status, consumer or chain id is rewritten here.

import { assetIdChainId, type Ledger, type LedgerDeposit } from "./ledger.ts";
import type { ChainStore } from "./chainstore.ts";

export class LegacyRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyRecoveryError";
  }
}

export interface LegacyChainEvidence {
  depositId: string;
  chainId: number;
  assetId: string;
  invoiceId: string;
  txHash: string;
  logIndex: number;
}

export function recoverLegacyChainDeposit(input: {
  ledger: Ledger;
  store: ChainStore;
  evidence: LegacyChainEvidence;
}): LedgerDeposit {
  const { ledger, store, evidence } = input;
  const deposit = ledger.deposit(evidence.depositId);
  if (!deposit) throw new LegacyRecoveryError(`deposit ${evidence.depositId} does not exist`);
  if (deposit.fundsClass !== "chain") {
    throw new LegacyRecoveryError(`deposit ${evidence.depositId} is ${deposit.fundsClass}, not a chain deposit; evidence recovery cannot relabel it`);
  }
  if (deposit.chainId !== evidence.chainId) {
    throw new LegacyRecoveryError(`deposit ${evidence.depositId} is on chain ${String(deposit.chainId)}, not ${evidence.chainId}`);
  }
  if (assetIdChainId(evidence.assetId) !== evidence.chainId) {
    throw new LegacyRecoveryError(`asset ${evidence.assetId} does not belong to chain ${evidence.chainId}`);
  }
  if (deposit.assetId !== null) {
    if (deposit.assetId === evidence.assetId) return deposit;
    throw new LegacyRecoveryError(`deposit ${evidence.depositId} already has asset ${deposit.assetId}; it cannot be rewritten`);
  }
  if (!evidence.depositId.startsWith("chain:")) throw new LegacyRecoveryError("a legacy chain deposit id must start with chain:");
  const eventId = evidence.depositId.slice("chain:".length);
  const event = store.event(eventId);
  if (!event) throw new LegacyRecoveryError(`no ChainStore event ${eventId} for deposit ${evidence.depositId}`);
  if (event.status !== "credited" || event.creditedNanos === null) {
    throw new LegacyRecoveryError(`event ${eventId} is ${event.status} and has no credited amount; it is not verified credit evidence`);
  }
  if (event.depositId !== evidence.depositId) throw new LegacyRecoveryError(`event ${eventId} does not point at deposit ${evidence.depositId}`);
  if (event.chainId !== evidence.chainId) throw new LegacyRecoveryError(`event ${eventId} is on chain ${event.chainId}`);
  if (event.txHash.toLowerCase() !== evidence.txHash.toLowerCase() || event.logIndex !== evidence.logIndex) {
    throw new LegacyRecoveryError(`event ${eventId} does not match tx/log ${evidence.txHash}:${evidence.logIndex}`);
  }
  if (event.invoiceId !== evidence.invoiceId) throw new LegacyRecoveryError(`event ${eventId} is claimed by ${String(event.invoiceId)}, not ${evidence.invoiceId}`);
  const expectedAsset = `eip155:${event.chainId}:${event.tokenContract.toLowerCase()}`;
  if (evidence.assetId !== expectedAsset) throw new LegacyRecoveryError(`event ${eventId} token is ${expectedAsset}, not ${evidence.assetId}`);
  if (event.creditedNanos !== deposit.amountNanos) {
    throw new LegacyRecoveryError(`event ${eventId} credited ${event.creditedNanos} nanos, deposit has ${deposit.amountNanos}; refusing recovery`);
  }
  const intent = store.intent(evidence.invoiceId);
  if (!intent) throw new LegacyRecoveryError(`no local deposit intent ${evidence.invoiceId}`);
  if (intent.chainId !== event.chainId) throw new LegacyRecoveryError(`intent ${evidence.invoiceId} is for another chain`);
  if (intent.consumerId !== deposit.consumerId) throw new LegacyRecoveryError(`intent ${evidence.invoiceId} belongs to another consumer`);
  if (intent.tokenContract.toLowerCase() !== event.tokenContract.toLowerCase() || intent.assetId !== expectedAsset) {
    throw new LegacyRecoveryError(`intent ${evidence.invoiceId} token does not match event ${eventId}`);
  }
  if (intent.recipientAddress.toLowerCase() !== event.toAddress.toLowerCase()) {
    throw new LegacyRecoveryError(`intent ${evidence.invoiceId} recipient does not match event ${eventId}`);
  }
  if (!intent.payerAddress || intent.payerAddress.toLowerCase() !== event.fromAddress.toLowerCase()) {
    throw new LegacyRecoveryError(`intent ${evidence.invoiceId} payer does not match event ${eventId}`);
  }
  if (intent.expectedAmountRaw !== event.amountRaw) {
    throw new LegacyRecoveryError(`intent ${evidence.invoiceId} amount does not match event ${eventId}`);
  }
  if (intent.status !== "matched" || intent.attributionStatus !== "matched") {
    throw new LegacyRecoveryError(`intent ${evidence.invoiceId} is ${intent.status}/${intent.attributionStatus}, not matched evidence`);
  }
  return ledger.reviewChainDepositProvenance({
    id: evidence.depositId,
    chainId: evidence.chainId,
    assetId: evidence.assetId,
    note: `recovered from ChainStore event ${eventId} tx ${event.txHash} log ${event.logIndex} invoice ${evidence.invoiceId}`,
  });
}
