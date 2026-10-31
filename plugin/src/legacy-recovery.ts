// The single public entry point for repairing a legacy chain deposit whose
// asset id was not stored. All evidence verification lives in
// Ledger.reviewChainDepositProvenance(); this wrapper only supplies the local
// ChainStore and the original invoice/tx/log identifiers. A bare asset patch
// cannot use that low-level mutator.
//
// Not exposed to UI/P2P. No amount, source, status, consumer or chain id is
// rewritten; only the missing asset metadata is filled after full evidence
// verification.

import type { Ledger, LedgerDeposit } from "./ledger.ts";
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
  try {
    return input.ledger.reviewChainDepositProvenance({
      id: input.evidence.depositId,
      chainId: input.evidence.chainId,
      assetId: input.evidence.assetId,
      store: input.store,
      evidence: {
        invoiceId: input.evidence.invoiceId,
        txHash: input.evidence.txHash,
        logIndex: input.evidence.logIndex,
      },
    });
  } catch (e) {
    if (e instanceof LegacyRecoveryError) throw e;
    throw new LegacyRecoveryError(String((e as Error)?.message ?? e));
  }
}
