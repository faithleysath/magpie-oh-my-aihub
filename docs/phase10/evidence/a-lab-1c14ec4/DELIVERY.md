# A-lab delivery manifest (HEAD 1c14ec4d4accf68dfef161c5f85bc8a18e6f6bf8)

Scope: same-host macOS arm64 lab; Magpie 0.1.2289 + EasyTier 2.6.4; **not** a P2P product GO.
Browser actor report is `A-LAB-1c14ec4-BROWSER.md` (owner 6a326f2b); the lab/protocol report is
`A-LAB-1c14ec4-E2E.md` (owner f63b644e).

## Allowed for repository

- both `.md` reports above;
- every file under `evidence/` (sanitized: no Gateway Key, network secret, login URL, ticket or ticket hash);
- the 8 selected screenshots in `screenshots/` (6a states none contains a key/ticket/net secret).

## Do NOT include

- `<lab-root>` (already deleted) or any `runtime.json`/key/state file;
- raw browser/web logs, console pairing codes, `k=` URLs, network secret, synthetic key material;
- the other 22 screenshots unless separately reviewed (full list + hashes in `evidence/screenshots.sha256`).

## Hash distinction (do not mix)

- **Original report hash**: `A-LAB-1c14ec4-E2E.md` = `d5c9a9eb…` (also in `evidence/reports.sha256`).
- **Reconstructed copy hash**: `evidence/copy-manifest-reconstructed.json` = `130542f5…`. This file was
  recomputed from the frozen HEAD **after** the lab root was deleted; it is **not** the original
  per-node `copy-manifest.json`. Before deletion both node copies were verified against their original
  manifests (76 files, 0 mismatch) — that verification is recorded in the E2E report, but the original
  per-node manifests no longer exist.
- **cleanup proof** = `e0c2787b…` (the file written by `cleanup --delete`; its `before`/`runningPids`
  are empty because the delete pass re-ran stop; the real PID list is in `evidence/cleanup-last.json`
  and `evidence/pid-manifest.json`, captured before the delete).

## Sanitized HTTP

`evidence/http-transcript-sanitized.json` contains request/response excerpts (status, Retry-After,
limit fields, migration detail). It is **not byte-exact raw**: raw response bodies were not persisted.
