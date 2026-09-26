# @ghostly/core

The Ghost protocol in platform-neutral TypeScript, shared by every Ghostly client: identities and crypto,
invites, Pkarr records and relays, DHT delivery, the chat session and its capabilities, transport
negotiation, files, payments, groups and identity proofs.

- Wire format: [docs/PROTOCOL.md](../../docs/PROTOCOL.md) and the [WISPs](../../docs/wisps/README.md).
- Where it sits: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).
- Outside authors get it through `@ghostly/sdk` (`@ghostly/sdk/core`), see [docs/SDK.md](../../docs/SDK.md).

```bash
npm test -w @ghostly/core                  # unit tests
npm run typecheck -w @ghostly/core
GHOSTLY_CLI=target/debug/ghostly-cli npm run test:interop   # live interop with the Rust CLI (network)
```

A change here can break every importer: `npm run test:affected` follows it through the barrel
(`src/index.ts`) to the tests that use it ([docs/TESTING.md](../../docs/TESTING.md#testing-only-what-changed)).
