# Build and install (production payments 0.6.0)

Date: 2026-11-01. Build platform: macOS 26.6.2 arm64, Bun 1.4.3, Node 24.21.0.

## Reproduce

From the repository root:

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run boot-check
bun run secret-scan
cd ..
npm pack --pack-destination dist
shasum -a 256 dist/oh-my-aihub-magpie-plugin-0.6.0.tgz
```

## Package

- Name: `@oh-my-aihub/magpie-plugin`
- Version: `0.6.0`
- File: `dist/oh-my-aihub-magpie-plugin-0.6.0.tgz`
- SHA-256: `1dc2c7dd2a18822f1857d4146a20b1c419ad5e596c5d2b3588b29e8de720e461`
- Size: 679 KiB packed / 2.7 MiB unpacked
- Files: 100 (source, console, page, bin, docs inside plugin; no tests, no node_modules)

## Install

In Magpie: **Plugins → Discover → add local package** and choose the tarball, or
use the GitHub branch after the draft PR is reviewed. Magpie manages Bun and the
host. No terminal, data path or wallet secret is required.

The package includes both production BSC/Base paths and the development testnets.
It does not include the fork-lab script or evidence; those stay in the repository.

## Verification notes

- Full test suite at this tree: 1423 tests / 0 fail (96 files), typecheck, boot-check,
  secret-scan PASS.
- Fork evidence is in `evidence/` with `SHA256SUMS`.
- The package was built from the exact tree that produced the evidence; the
  SHA-256 above is the tarball, not a commit.
