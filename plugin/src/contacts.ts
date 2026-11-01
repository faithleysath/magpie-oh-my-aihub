// The address book: a local `alias → address` map.
//
// It exists so a person can say "转 5 USDC 给张三" instead of pasting a 0x
// address. That is all it is. An alias never enters a signature, never appears in
// the signed catalogue, never grants model access, and is not a send allowlist:
// `send_payment` still broadcasts to whatever address the alias resolves to, with
// no extra confirmation (D11). An alias that resolves to nothing is an error,
// never a guess — a typo must not become a payment to someone else.
//
// Aliases are trimmed, whitespace-collapsed and lowercased on both write and
// lookup, so `" Zhang San "` and `"zhang san"` are one alias. One address may
// carry several aliases; one alias points at exactly one address. Re-adding an
// alias repoints it and tells the caller which address it replaced, so a
// repoint can be reported instead of happening silently. Re-adding with the note
// left out keeps the stored note.

import type { Database } from "bun:sqlite";

export interface Contact {
  alias: string;
  address: string;
  note: string | null;
  createdAt: string;
}

interface ContactRow {
  alias: string;
  address: string;
  note: string | null;
  created_at: string;
}

export function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function toContact(row: ContactRow): Contact {
  return { alias: row.alias, address: row.address, note: row.note, createdAt: row.created_at };
}

/** Every contact, by alias. */
export function listContacts(db: Database): Contact[] {
  const rows = db
    .query("SELECT alias, address, note, created_at FROM contacts ORDER BY alias")
    .all() as ContactRow[];
  return rows.map(toContact);
}

export function contactByAlias(db: Database, alias: string): Contact | null {
  const row = db
    .query("SELECT alias, address, note, created_at FROM contacts WHERE alias = ?")
    .get(normalizeAlias(alias)) as ContactRow | null;
  return row ? toContact(row) : null;
}

/**
 * Writes one alias and returns it, plus the address it pointed at before when
 * this replaced a different one.
 */
export function saveContact(
  db: Database,
  input: { alias: string; address: string; note?: string | null; now?: string },
): { contact: Contact; previousAddress: string | null } {
  const alias = normalizeAlias(input.alias);
  const address = input.address.toLowerCase();
  const existing = contactByAlias(db, alias);
  // Leaving the note out keeps the stored one; only an explicit null clears it.
  const note = input.note === undefined ? (existing?.note ?? null) : input.note;
  const previousAddress = existing && existing.address !== address ? existing.address : null;
  const createdAt = input.now ?? new Date().toISOString();
  db.run(
    "INSERT INTO contacts(alias, address, note, created_at) VALUES(?,?,?,?) " +
      "ON CONFLICT(alias) DO UPDATE SET address = excluded.address, note = excluded.note, " +
      "created_at = excluded.created_at",
    [alias, address, note, createdAt],
  );
  return { contact: { alias, address, note, createdAt }, previousAddress };
}

/** Removes one alias; null when it was not there. */
export function deleteContactByAlias(db: Database, alias: string): Contact | null {
  const existing = contactByAlias(db, alias);
  if (!existing) return null;
  db.run("DELETE FROM contacts WHERE alias = ?", [existing.alias]);
  return existing;
}

/** Removes every alias of one address; empty when there was none. */
export function deleteContactsByAddress(db: Database, address: string): Contact[] {
  const removed = listContacts(db).filter((contact) => contact.address === address.toLowerCase());
  if (removed.length > 0) db.run("DELETE FROM contacts WHERE lower(address) = lower(?)", [address]);
  return removed;
}
