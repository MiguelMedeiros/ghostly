# Ghostly SDK: build a wallet source, an identity proof or a client outside the app

`@ghostly/sdk` (`packages/sdk`) is what someone building *for* Ghostly needs, without reading its
internals: the adapter contracts, the fakes and contract test suites the app tests itself with, the
plugin registry, and the protocol library for a minimal client. The app imports the very same code;
the package is a build of it, not a copy.

| Entry point | What is in it | Needs |
|---|---|---|
| `@ghostly/sdk` | the `LightningProvider` / `OnchainProvider` contracts and descriptors, `NothingSpentError`; the `IdentityProofProvider` contract, its signers and `verifyIdentity`; `registerAdapters` and the plugin type; the transport and record contracts | nothing |
| `@ghostly/sdk/fakes` | the fake sources (`FakeLightningProvider`, `FakeOnchainProvider`, `fakeInvoice`, `fakeAddress`) and fake identities (`fakeKey`, `fakeAccount`, `fakeRecord`) | nothing |
| `@ghostly/sdk/testing` | the fakes plus the contract suites: `describeLightningProvider`, `describeOnchainProvider`, `describeIdentityProof` | vitest (peer) |
| `@ghostly/sdk/core` | the whole protocol library (`packages/core`): identities and records, invites, Pkarr rendezvous, the data link and its frames, paired sessions and capabilities, payments, identity proofs | nothing |

The vocabulary is the [adapter roadmap](wisps/ADAPTER-ROADMAP.md)'s: a **WISP** is a contract; a
**capability** is what a running client advertises; an **adapter** implements a contract with a
technology; a **provider** operates a service or a wallet; a **signer** authorizes one cryptographic
operation; a **plugin** packages adapters for distribution. This SDK is for adapters and plugins.

## Getting it

The package is not on npm yet. Pack it from a checkout and install the tarball:

```bash
npm ci
npm pack --workspace @ghostly/sdk --pack-destination /tmp/ghostly-sdk    # builds it first
cd your-adapter && npm install /tmp/ghostly-sdk/ghostly-sdk-*.tgz
```

[`examples/sdk-adapter`](../examples/sdk-adapter) is a complete project that does exactly this: a
Lightning source and an identity proof, their contract tests, and a plugin the app loads.
`npm run test:sdk-example` at the repository root packs the SDK, installs the tarball into the example
and runs its checks; CI runs it on every pull request.

## Trust model, first

**An adapter runs with the app's privileges.** It is JavaScript in the same realm as the engine: it can
read every key, sign anything, spend everything, and reach any network the page can. There is no
sandbox, no permission prompt, no signature check and no store. Whoever compiles a plugin into a build,
or runs code that calls `registerAdapters`, trusts its author with all of that. The manifest with
permissions, the isolated runtime and package signing are a later phase of the roadmap ("Plugins,
apps, catalogs and GhostlyOS"); until then, release builds of Ghostly carry no plugin, and test builds
carry only the example.

What the engine *does* enforce, for every provider, built-in or not: the platform and mode rules of the
pickers; the network check before a source is saved; the checks on what a provider returns (an invoice
decodes and matches what was asked, a fee is within the cap, a prepared transaction pays the reviewed
address and amount, a test-network invoice is refused in Mainnet); the journal-before-spend and
persist-before-spend rules; sealing of secret fields; the strict evidence bounds of identity proofs; and
that `verify` fetches only through the bounded `ctx.fetch`. None of that protects the person from a
malicious adapter. It protects them from an honest one's mistakes.

## A wallet source

A **Lightning source** creates and pays invoices (a node, a remote wallet, a mint); an **on-chain
source** gives addresses, signs and broadcasts transactions (a BDK wallet, a Bitcoin Core wallet). One
of each is active per profile and per network (a Testnet wallet and a Mainnet wallet each have their own). Everything around it is the app's: storage, sealed
secrets, per-mode sources, the picker and its form, the Lightning journal, the on-chain
review/approve/reconcile flow, reconciliation of lost answers.

```ts
import { NothingSpentError, type LightningProvider, type LightningProviderDescriptor } from "@ghostly/sdk";

class MyLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  async info() { return { network: "regtest" as const, alias: "my node", balance: 21_000 }; }
  async createInvoice(amount: number, memo?: string) { /* … */ }
  async invoiceStatus(invoice) { /* … */ }
  async payInvoice(invoice: string, maxFee: number) { /* paid | pending, or throw */ }
  async paymentStatus(payment) { /* … */ }
  async close() { /* … */ }
}

export const myLightning: LightningProviderDescriptor = {
  id: "my-lightning",                      // stable: stored with the profile; ^[a-z][a-z0-9-]{0,31}$
  label: "My node",
  kind: "lightning",
  description: "Your own node over its API. It holds the sats.",
  networks: ["bitcoin", "signet", "regtest"], // a mode offers only providers with a network of that mode
  platforms: ["web", "extension", "desktop"],
  fields: [{ name: "url", label: "API URL", kind: "url" }, { name: "token", label: "Token", kind: "secret" }],
  validate({ config, secrets }) { /* throw a message the person can act on, before anything is contacted */ },
  async create({ config, secrets }, host) { return MyLightning.connect(config.url, secrets.token, host.signal); },
};
```

The full contracts, with the meaning of every field, are the TSDoc of `LightningProvider`,
`OnchainProvider` and `ProviderDescriptor` in the package's types. `providerDescriptorProblems(d)`
tells you what the registry would refuse.

### Money safety (not optional)

- **`NothingSpentError` only when nothing left.** Throw it only when it is certain no money moved
  (refused before sending, no route before any HTLC, a transaction never broadcast, not enough funds).
  The engine then marks the attempt `failed` and lets the person try again. **Any other throw is an
  unknown outcome**: the payment is journaled as `unknown`, only ever reconciled through
  `paymentStatus` / `status`, never paid again, and the source cannot be replaced until it ends. When
  in doubt, do not throw `NothingSpentError`. The engine recognizes the error by its `name`, so a copy
  of the class bundled with your plugin is understood too.
- **`pending` is not `failed`.** `payInvoice` resolves `pending` for a payment in flight; never resolve
  or throw "failed" for something that may still settle.
- **Sign at prepare, broadcast at execute.** `prepareSend` returns the signed transaction for exactly
  the reviewed address, amount and fee (at most `feeCap`); `broadcast` sends that transaction and
  nothing else; re-broadcasting it after a lost answer cannot pay twice. `release` unlocks what a
  cancelled review reserved.
- **Validate what your backend returns**, and bound what you read (sizes, time-outs). The engine
  checks the invoice, the fee, the prepared transaction and the txid again; that is a net, not a licence.
- Amountless invoices are refused for now. Say in `description` when your backend takes no fee limit
  (NWC's `pay_invoice` carries none): the fee is then the wallet's.

### Secrets

- Declare every credential (URI, macaroon, rune, API key, RPC password) as a `secret` field. It is
  sealed with a device key, never in the engine state, never shown again, never logged.
- Never log a secret and never put one in an error message. Messages shown to the person pass through
  `redact()` with the source's secrets, as a safety net.
- A provider gets its secrets in `create()` and keeps them in memory only.

### Platforms and modes

`platforms` says where the provider can run: the engine runs in the page on `web` and `desktop`
(Tauri) and in an offscreen document in the `extension`. A provider that needs `window.webln` is
`["web"]`; one that needs a raw socket or a local process is `["desktop"]` and gets there through
`host.invoke` (a Tauri command, which is the app's to add: see `PROVIDERS.md`). Browsers reach HTTP
APIs only with CORS; say so in `description` when a node must allow the origin.

Mainnet and Testnet keep separate sources. `info().network` must be a network of the mode the source
is used in (`bitcoin` is Mainnet, everything else Testnet); a provider on the wrong one is closed and
refused before anything is saved. `host.signal` aborts when the source is replaced, the mode switches
or the engine stops: end long waits on it.

## An identity proof

An identity proof lets a person show a contact, per contact, that they control an external identity.
A provider is one kind of identity: how the person produces evidence over the shared statement
(`signers`) and how any Ghostly app checks it (`verify`). The statement bytes, the proof key, sharing
and withdrawing per contact, replay protection, storage, expiry, re-checks and the whole UI are the
app's: the UI renders every provider from its descriptor.

```ts
import type { IdentityProofProvider } from "@ghostly/sdk";

export const myKey: IdentityProofProvider<{ sig: string }> = {
  id: "my-key", label: "My key", category: "self-custodied",
  summary: "Sign once with your key",                 // the picker card, about 40 characters
  description: "Proves you hold a key: sign the statement with it.",
  platforms: ["web", "extension", "desktop"],
  subject: { label: "Public key", normalize: canonical, short: fingerprint },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: "Nothing: the signature is checked on this device.",
  signers: [{ id: "tool", kind: "external-tool", label: "Sign outside Ghostly",
    instructions: (s) => ({ steps: [{ text: "Sign these bytes:", copy: s.text }], paste: { label: "Signature" } }),
    parse: (pasted) => ({ sig: parseSignature(pasted) }) }],
  parseEvidence: (raw) => strictShape(raw),        // exact keys, bounded strings, nothing extra
  async verify(statement, evidence, ctx) { /* check over statement.bytes; return { subject, source } */ },
};
```

Rules the contract suite checks and the engine enforces:

- **Sign `statement.text` / `statement.bytes`**, never a rebuilt string. Use `statement.id` (or hash
  it into) the `nonce` of an OpenID Connect request.
- **Self-custodied** providers return `subject === statement.binding.subject`; **provider-attested**
  ones return the attested account and set `attester`.
- **`verify` reaches the network only through `ctx.fetch`** (HTTPS GET, bounded, no credentials,
  refused offline). The suite fails a provider that touches the global `fetch`. Fetch only fixed,
  well-known endpoints or ones derived from the subject, never a URL from the evidence. Use `ctx.now`
  for time and `ctx.signal` for cancellation.
- `parseEvidence` is strict: exact keys, bounded sizes, no extra fields. Evidence is capped at 16 KiB.
- Write in `privacy` who learns what. Declare `recheck` when a published record can disappear.
- Signers run in the UI, never in the engine. A `redirect` signer must open its popup synchronously
  from the click. `lookupDisplay` runs only when the person asks.

The four signer kinds (`in-app`, `external-tool`, `redirect`, `publish`) and the exact statement
format are in `packages/browser/src/proofs/PROOFS.md` and [WISP 300](wisps/300-peer-proofs.md).
`identityDescriptorProblems(p)` tells you what the registry would refuse.

## Registration: a plugin, not a registry line

A plugin is a plain object naming its adapters:

```ts
import { SDK_API, type GhostlyAdapterPlugin } from "@ghostly/sdk";

const plugin: GhostlyAdapterPlugin = { id: "my-adapters", version: "1.0.0", sdk: SDK_API, lightning: [myLightning], identities: [myKey] };
export default plugin;
```

Two ways into the app, both additive to the built-in lists (built-ins first, then plugins, then the
test fakes), both under the same platform and mode rules:

- **At build time.** `GHOSTLY_PLUGINS=path/to/plugin.ts npm run build:web` (comma-separated paths from
  the repository root, each default-exporting a plugin) compiles them into the web app, the extension
  or Desktop. Inside the app, `@ghostly/sdk` resolves to the app's own source, so the plugin and the
  engine share one copy of everything. This is how the e2e build carries the example.
- **At run time.** Code already running in the engine's realm calls `registerAdapters(plugin)`; the
  pickers update at once, and the function returned unregisters. On the web and on Desktop that realm
  is the page; in the extension it is an offscreen document nothing outside can reach, so there it is
  build time only. The registry lives on `globalThis`, so a plugin bundled with its own copy of the
  SDK registers into the same lists.

`registerAdapters` refuses, registering nothing: a malformed plugin or descriptor
(`pluginProblems` lists why), an id a built-in owns, an id another plugin already took, a contract
generation other than `SDK_API`. A registered id that later collides with a new built-in is dropped
with a console error: the built-in wins, and your id should be distinctive.

There is no way to load a plugin from a URL, a file or a store, on purpose (see the trust model).

## Transports and a minimal client

The contracts a transport implements are exported: `PkarrTransport` (rendezvous: publish and resolve
signed packets, [WISP 100](wisps/100-transports.md)), `NativeEndpoint` / `BoundChannel` /
`NativeBinding` (a paired data transport with its authenticated binding, [102](wisps/102-iroh.md) and
[103](wisps/103-hyperdht.md)) and `FrameChannel`. They can be handed to the engine only through the
host's options today (`NodeOptions.transport`, `NodeOptions.nativeTransports` in `packages/browser`),
and the transport identifiers are a closed set negotiated on the wire (`TRANSPORTS`): a new transport
needs a WISP and an app change, not a plugin. There is no registration for transports yet; this
section says so rather than pretend.

A **minimal client** that implements only the WISP contracts it needs uses `@ghostly/sdk/core`: the
protocol library the apps and the CLI are built on. It follows the WISP drafts it implements, and
[PROTOCOL.md](PROTOCOL.md) describes the wire.

## Testing

- **Contract suites** (`@ghostly/sdk/testing`): every adapter runs the suite of its kind against
  itself, with a harness that knows how to make things happen on its network (a fake, a regtest
  counterpart, a stubbed network). `describeLightningProvider` / `describeOnchainProvider` take a
  harness with the provider, its `network`, optionally its `descriptor` (checked too), and how to pay
  its invoice or fund it; `describeIdentityProof` takes the provider, a `subject` you control,
  `prove`, `proveAsOther`, a stubbed `fetch` and `revoke` for re-checks. The suites are the ones in
  `packages/browser`, moved into the source so the app and you run the same file.
- **Fakes** (`@ghostly/sdk/fakes`): in-memory regtest sats and test identities that hold nothing and
  reach nothing, to drive your tests without a network.
- **Real networks**: gate on an environment variable (`GHOSTLY_<NAME>_REGTEST=1`), skip otherwise,
  never real funds, never a real account, never print a secret.
- **In the app**: `GHOSTLY_PLUGINS=… npm run build:web`, then `npx vite preview web`; or add a spec
  next to `e2e/web/sdk-plugin.spec.ts`, which drives the example through the pickers.

## Versioning and stability

- The SDK carries Ghostly's version (`0.4.0` today; `scripts/bump-version.mjs` bumps it with the rest).
  Before `1.0.0`, a **minor** may change a contract and says so in `CHANGELOG.md`; a **patch** never
  does. From `1.0.0`, semver applies to everything the entry points export.
- `SDK_API` is the contract generation (`1`). A plugin declares the one it was written against and is
  refused by an app that speaks another; it changes only when a contract changes incompatibly.
- The public surface is exactly what the entry points export, checked by name in
  `packages/sdk/test/surface.test.ts`: a name that leaves is a breaking change. Type shapes are
  documented in their TSDoc; there is no generated reference yet, the declarations shipped in the
  package are it.
- `@ghostly/sdk/core` follows the WISP drafts (`docs/wisps`): a Draft may change, minor by minor,
  until it is Final. Wire capability names and versions never change silently.
- Not stable, not exported: the engine, storage, the UI, the built-in providers' modules.

## Further reading

- [`packages/browser/src/engine/paymentAdapters/PROVIDERS.md`](../packages/browser/src/engine/paymentAdapters/PROVIDERS.md): the wallet provider contract in depth, the built-in providers, Desktop commands.
- [`packages/browser/src/proofs/PROOFS.md`](../packages/browser/src/proofs/PROOFS.md): the identity proof model, the statement bytes, the wire frames, the built-in providers.
- [Adapter roadmap](wisps/ADAPTER-ROADMAP.md): what is planned, the promotion gates, the plugin phase.
- [Architecture](ARCHITECTURE.md), [Protocol](PROTOCOL.md).
