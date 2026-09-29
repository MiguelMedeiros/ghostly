# @ghostly/browser

The Ghostly peer for JavaScript hosts: the engine (`GhostlyNode`, `src/engine/`), wallets and their
providers (`src/engine/paymentAdapters/`), identity proofs, profiles, backups, IndexedDB and file storage,
and the platform layer the shared UI (`src/`) is built with.

- `src/host.ts`: the small contract a host implements (web app, extension, Desktop). The headless CLI
  ([packages/cli](../cli/README.md)) runs the same engine on Node, with no UI.
- `src/platform/` and `vite-plugin.ts`: `ghostlyPlatformModules()` swaps the UI's platform modules for
  ones backed by this peer; `GHOSTLY_PLUGINS` compiles SDK adapter plugins in.
- Providers and their contract: [PROVIDERS.md](src/engine/paymentAdapters/PROVIDERS.md).

```bash
npm test -w @ghostly/browser               # unit tests (the gated *.regtest tests skip)
npm run typecheck -w @ghostly/browser
npm run test:group-load                    # community load test (GROUP_LOAD=256 members by default)
```

The gated provider contracts (`test/*.regtest.test.ts`, `breez.testnet.test.ts`) need their services: the
e2e stack, or Breez's hosted regtest ([e2e/README.md](../../e2e/README.md#the-gated-suites)).
