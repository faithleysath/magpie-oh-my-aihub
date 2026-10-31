// Browser-side operationPort for the local authenticated payment service.
//
// The existing ConsoleSession owns the cookie/CSRF/idempotency transport. This
// module only maps the approved external-wallet operationPort methods to the
// fixed console action names; it never stores credentials, session ids, owner
// ids or provider/price fields. The caller passes the previewRef it received
// from `payment-obligation-preview`; the server resolves the trusted obligation
// from its own persisted verified payment request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBLIGATION = /^[A-Za-z0-9._:-]{1,128}$/;

function reject(message) {
  throw new Error(message);
}

/**
 * @param {{
 *   callAction: (name: string, body: Record<string, unknown>) => Promise<unknown>,
 *   obligationId: string,
 *   previewRef: string,
 * }} options
 */
export function createConsolePaymentPort(options = {}) {
  const { callAction, obligationId, previewRef } = options;
  if (typeof callAction !== "function") reject("a console action function is required");
  if (typeof obligationId !== "string" || !OBLIGATION.test(obligationId)) reject("invalid payment obligation id");
  if (typeof previewRef !== "string" || !UUID.test(previewRef)) reject("invalid payment preview reference");

  const bound = (extra) => Object.freeze({ obligationId, previewRef, ...extra });

  return Object.freeze({
    async reserve(operation) {
      return await callAction("payment-operation-reserve", bound({ operation }));
    },
    async markBroadcasting({ reservationId, operation }) {
      if (typeof reservationId !== "string" || !UUID.test(reservationId)) reject("invalid reservation id");
      await callAction("payment-operation-mark", bound({ reservationId, operation }));
    },
    async recordHash({ reservationId, operation, hash }) {
      if (typeof reservationId !== "string" || !UUID.test(reservationId)) reject("invalid reservation id");
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) reject("invalid transaction hash");
      await callAction("payment-operation-hash", bound({ reservationId, operation, hash }));
    },
    async recordUnknown({ reservationId, operation, reason }) {
      if (typeof reservationId !== "string" || !UUID.test(reservationId)) reject("invalid reservation id");
      await callAction("payment-operation-unknown", bound({ reservationId, operation, reason }));
    },
    async query(operation) {
      return await callAction("payment-operation-query", { obligationId, operation });
    },
    async pending() {
      return await callAction("payment-operation-pending", {});
    },
  });
}

export const PAYMENT_LOCAL_ACTION_NAMES = Object.freeze([
  "payment-obligation-preview",
  "payment-operation-reserve",
  "payment-operation-mark",
  "payment-operation-hash",
  "payment-operation-unknown",
  "payment-operation-query",
  "payment-operation-pending",
]);
