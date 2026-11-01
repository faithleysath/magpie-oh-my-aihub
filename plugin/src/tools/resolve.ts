// An address argument that may be written as a contact alias.
//
// Every tool that takes a counterparty address goes through here, so "给张三转 5"
// and "批准张三" work without pasting hex. Resolution is exact: a 0x address wins,
// otherwise the alias must be in the local address book. No prefix matching, no
// "the only contact I have" fallback — a name that does not resolve is `E_INPUT`
// listing the known aliases, because a typo must never silently pick a different
// counterparty.

import { contactByAlias, listContacts } from "../contacts.ts";
import { getRuntime } from "../runtime.ts";
import { fail, isAddress } from "./types.ts";

const MAX_LISTED_ALIASES = 20;

export async function resolveTarget(raw: string, label: string): Promise<string> {
  const value = raw.trim();
  if (isAddress(value)) return value.toLowerCase();

  const runtime = await getRuntime();
  const contact = contactByAlias(runtime.db, value);
  if (contact) return contact.address;

  const known = listContacts(runtime.db).map((entry) => entry.alias);
  if (known.length === 0) {
    fail("E_INPUT", `${label} is not a 0x… address, and the address book is empty (add one with contacts)`);
  }
  const listed = known.slice(0, MAX_LISTED_ALIASES).join(", ");
  const more = known.length > MAX_LISTED_ALIASES ? ` (+${known.length - MAX_LISTED_ALIASES} more)` : "";
  fail("E_INPUT", `${label} is neither a 0x… address nor a known contact; contacts: ${listed}${more}`);
}
