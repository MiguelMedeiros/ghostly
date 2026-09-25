# Wallet providers: sources of Lightning and on-chain Bitcoin

A **provider** is a way to reach money: the Cashu mints, an LND node, a Nostr Wallet Connect wallet, a
BDK wallet, a Bitcoin Core wallet. Each profile has one **active source** of each kind per wallet mode:

| Kind | Contract | Default | Used by |
|---|---|---|---|
| Lightning | `LightningProvider` ([providers/lightning.ts](providers/lightning.ts)) | the Cashu mints ([providers/cashuMint.ts](providers/cashuMint.ts)) | the Lightning card, the invoice a chat request carries, paying a contact's invoice, invoices pasted in a chat |
| On-chain | `OnchainProvider` ([providers/onchain.ts](providers/onchain.ts)) | none: the Bitcoin card says "No Bitcoin source configured" | the Bitcoin card, the `bitcoin` payment method of the `PaymentCoordinator` |

The Cashu card always uses the mints directly, whatever the Lightning source.

In a chat, on-chain Bitcoin is the `bitcoin` way of paying (endpoint `btc-onchain/1`): a request carries a fresh
address of the payee's source, a Send asks the contact's app for one, the payer's review is a transaction signed
by its source, and the payer sends the txid as a hint. The payee's request is paid only once its own source shows
a confirmed transaction paying that address at least the amount: through `received(address)` when the provider
has it, else the hint checked against `history`. It is allowed only through the `paired-payments` list of an open
session, never offered in the handshake (a full offer already has the 16 capabilities older apps accept).

Everything that is not specific to a provider is shared and already written: storage, sealed secrets,
per-mode sources, the source picker and config form, the Lightning journal and reconciliation, the
on-chain review/approve/reconcile flow. A provider is one module and one line.

A provider written **outside the app** needs no line here: it is a plugin registered through the SDK
(`@ghostly/sdk`, `registerAdapters` or `GHOSTLY_PLUGINS` at build time), listed after the built-ins
under the same platform and mode rules. See [docs/SDK.md](../../../../../docs/SDK.md) and
`packages/browser/src/plugins/registry.ts`; the contracts, fakes and contract suites below are what it
exports.

## Adding a provider

1. Write `providers/<name>.ts`: a class implementing `LightningProvider` or `OnchainProvider`, and a
   descriptor:

   ```ts
   // A shortened version of providers/nwc.ts.
   export const nwc: LightningProviderDescriptor = {
     id: "nwc",                        // stable: it is stored with the profile
     label: "Nostr Wallet Connect",
     kind: "lightning",
     description: "A wallet you connect with an NWC URI. That wallet holds the sats.",
     networks: ["bitcoin", "signet", "regtest", "mutinynet"],   // offered in the modes of these networks
     platforms: ["web", "extension", "desktop"],               // where it can run
     fields: [{ name: "uri", label: "Connection URI", kind: "secret", placeholder: "nostr+walletconnect://…" }],
     custodial: true,
     validate({ secrets }) { if (!secrets.uri.startsWith("nostr+walletconnect://")) throw new Error("That is not an NWC URI"); },
     async create({ config, secrets }, host) { return NwcLightning.connect(secrets.uri, host.signal); },
   };
   ```

2. Add it to `LIGHTNING_PROVIDERS` or `ONCHAIN_PROVIDERS` in [providers/registry.ts](providers/registry.ts).
   That is the only shared line you touch; keep the list in the order the picker should show.

3. Only if the declared `fields` cannot express the form (a "Connect" button that asks a browser wallet, a
   QR scanner): register a component in `src/components/wallet/providers/forms.ts` under the provider id.
   It receives `ProviderFormProps` and calls `onSubmit(values)`.

4. Tests: run `describeLightningProvider` / `describeOnchainProvider` from
   [providers/contractSuite.ts](providers/contractSuite.ts) (`test/helpers/providerContract.ts` re-exports
   them) against your provider (mocked transport in unit tests; a real regtest counterpart in a gated
   test), plus your own unit tests. See "Testing" below.

The engine then: lists it in the picker when the platform and the mode fit, renders its form, splits the
values into `config` (shown back) and `secrets` (sealed), calls `create`, asks `info()` and **refuses a
network of the other mode** before saving anything, and closes it on a mode switch, a replacement or
shutdown (`close()`, and `host.signal` aborts).

## Connecting, and when it cannot

A saved source is connected in the background when the app starts, and **kept trying** while it cannot be
reached: every failed attempt waits longer before the next (2 s, doubling up to 5 minutes, ±20 %), and an
attempt starts at once on **Retry** or when the app wakes (back online, back in front: the engine's `wake`).
Meanwhile the card says "Connecting…" with the last balance the source read (`<kind>SourceSeen-<mode>`),
and it becomes "Unavailable" only once the failure is sustained (3 attempts over at least 30 s), or at once
for a wrong setting. It connects by itself as soon as the server answers again.

So `create` (and `info`) should say **why** they fail:

- `SourceUnreachableError`: no answer (a time-out, a refused connection, no network, a 5xx). Tried again.
- `SourceConfigError`: a setting is wrong (a server on another network, not the API expected, a phrase
  that makes no wallet). Shown as unavailable at once; waiting does not fix it.
- Anything else is taken as no answer. Both are recognised by `name`, so a plugin's own copies work.

Say which server and what it did, precisely: "nothing answers at 127.0.0.1:44201: the local Esplora server is
not running", "the Esplora server at blockstream.info did not answer in 20 s", "wrong network: the Esplora
server at … is on testnet4, not signet". Listen to `host.signal`: a change of settings interrupts an attempt
under way (the engine also gives up on one that ignores it, and closes what arrives later).

A field marked `changeable` (a server address that does not change whose money it is, like a BDK wallet's
Esplora) can be edited on a saved source with **Change server** (`ProviderSources.reconfigure`): the secrets
stay sealed and are not typed again, and the new server is connected and checked before it is saved. Never
mark a field that picks another account (a node's URL: another node is other money). `suggestions` offer
values under a field, filtered by the other fields (`when`): public servers per network, for instance.

## Money safety

- **Nothing spent vs unknown.** Throw `NothingSpentError` only when it is certain nothing left the wallet
  (refused before sending, no route before any HTLC, a transaction never broadcast, not enough funds). It
  makes the attempt `failed` and retryable. **Any other throw is an unknown outcome**: the payment is
  journaled as `unknown`, only ever reconciled (`paymentStatus`, `status`), never paid again, and the
  source cannot be replaced until it ends. When in doubt, do not throw `NothingSpentError`.
- **Journal before spend.** Lightning payments are written to the journal (`lightningOp-out-<hash>` in the
  settings store) before `payInvoice` is called; an interrupted `sending` becomes `unknown` at the next
  start. On-chain payments go through the `PaymentCoordinator`: persist-before-spend and atomic claim.
- **Sign at prepare, broadcast at execute.** `prepareSend` returns the signed transaction for exactly the
  reviewed address, amount and fee (≤ `feeCap`). `broadcast` sends that transaction; reconciling a lost
  answer re-broadcasts the same one (same inputs: it cannot pay twice). `release` unlocks what a cancelled
  review reserved.
- **Pending is not failed.** `payInvoice` resolves `pending` for a payment in flight; never resolve or
  throw "failed" for something that may still settle.
- **Checks you do not write.** The engine checks what a provider returns: an invoice decodes and has the
  amount and hash asked for; the fee is within the cap; the prepared transaction pays the reviewed address
  and amount; the txid broadcast is the one reviewed; in Mainnet, an invoice of a test network is refused.
  Still validate everything your backend returns, and bound what you read (sizes, time-outs).
- Amountless invoices are refused for now.
- When the backend has no fee limit of its own to pass (NWC's `pay_invoice` carries none), say so in the
  description: the fee is the wallet's, and the one it reports is passed on as it is.

## Secrets

- Declare every credential (NWC URI, macaroon, rune, API key, RPC password) as a `secret` field. It is
  sealed with a device key (`sealSeed`, like the Ark and USDT seeds) under `<kind>Source-<mode>` in the
  settings store: never in the `Settings` object, never in the engine state (the view lists only the
  names of the saved secret fields), never shown again.
- Never log a secret, and do not put one in an error message. Errors shown to the person pass through
  `redact()` with the source's secrets, but that is a safety net, not a licence.
- A provider gets its secrets in `create()` and keeps them in memory only.

## Per mode

- Mainnet and Testnet keep separate sources (`lightningSource-mainnet`, `lightningSource-testnet`,
  `onchainSource-…`). Switching closes one and opens the other; nothing is replaced.
- `info().network` must be a network of the mode: `bitcoin` is Mainnet, every other network is Testnet.
  A provider on the wrong one is closed and refused.
- The journal and the on-chain intents carry their mode and provider: another source's operations wait
  until it is active again (only it can answer about them).

## Platforms

`platforms` says where the provider can run. The engine runs in the page for `web` and `desktop` (Tauri)
and in an offscreen document for `extension`: a provider that needs `window.webln` is `["web"]`; one that
needs a raw TCP socket or a local process is `["desktop"]` and gets there through a Tauri command.
Browsers reach HTTP(S) APIs only with CORS; say so in the description when a node must allow the origin.

On desktop, `host.invoke(command, args)` calls a command of the Tauri app (`src-tauri/src/`); it is absent on
the web and in the extension. Register the command in `src-tauri/build.rs` (`COMMANDS`), `main.rs` and
`capabilities/default.json`, and keep it narrow: the LND provider's `lnd_request` (`src-tauri/src/lnd.rs`)
only reaches LND's REST paths, pins the node's certificate, and bounds sizes and time. A provider can offer
the same API both ways, `fetch` in a browser and a command on desktop (see `providers/lnd.ts`).

### The browser wallet (WebLN)

[providers/webln.ts](providers/webln.ts) is the example of a provider that lives in the page. How the call
reaches `window.webln` on each platform:

| Platform | Engine runs in | `window.webln` |
|---|---|---|
| web | the app's own page | yes: a WebLN extension (Alby…) injects it into the page, and the engine calls it directly |
| extension | an offscreen document of Ghostly's extension | no: other extensions do not inject into `chrome-extension://` pages, the offscreen document included |
| desktop | the Tauri webview | no: a webview runs no browser extensions |

So it is `platforms: ["web"]`. It has no fields and no secret (the wallet keeps its own keys): its form is
`WeblnForm` in `src/components/wallet/providers/`, a "Connect browser wallet" button that says whether a
wallet is in the page. Connecting calls `enable()` (the wallet's own approval prompt), then:

- **What it can do** comes from `getInfo().methods` when the wallet lists them (Alby puts every method on the
  object whether its account supports it or not), else from the functions present: `makeInvoice` → receive,
  `sendPayment` → send, `getBalance` (in sats or msats) → balance, `lookupInvoice` → lookup.
- **Its chain**: WebLN has no field for it. A chain the wallet names in `getInfo()` is taken; otherwise the
  wallet makes a 1-sat invoice, whose prefix says it. A wallet that can only pay and names no chain is
  Mainnet only (in Testnet it could be spending real sats as "test sats"). Every invoice it makes or is asked
  to pay is checked against that chain anyway.
- **Paying**: Ghostly's review and approval come first; the wallet may then show its own prompt. WebLN takes
  no fee limit, so the wallet applies its own; the fee is shown when the wallet reports it. A preimage that
  hashes to the payment hash is paid. `NothingSpentError` only for what certainly did not leave: Ghostly's own
  checks (chain, balance from `getBalance`), the person refusing the wallet's prompt (`User rejected`,
  `RejectionError`…), or the wallet giving up before any HTLC (`no_route`, `insufficient_balance`). Anything
  else (no answer within 5 minutes, an error that says nothing, an answer without a valid preimage) is
  unknown, and reconciled with `lookupInvoice` when the wallet has it. WebLN has no word for "failed", so a
  lookup either finds the payment paid or leaves it pending; without `lookupInvoice` an unknown payment stays
  unknown, and the Lightning card says to check it in the wallet itself.

### A federation (Fedimint)

[providers/fedimint.ts](providers/fedimint.ts) is a source over a wallet the engine already holds: the Fedimint
card's federations (`FedimintWallet`, handed over as `host.fedimint`, reserved like `host.cashu`). Its one field is
the federation's id; its form (`FedimintForm`) lists the joined federations with a Lightning module instead of
asking for it, and the Fedimint card's **Use for Lightning** sets it directly. Invoices are paid into the
federation's ecash through its gateway; paying funds a contract the gateway claims, for the fee it advertises
(estimated before paying and held to the reviewed maximum; the client passes no limit of its own). Refused before a
contract is funded is `NothingSpentError`; after, `pending` until the client's operation says paid (a preimage) or
refunded. An invoice of the same federation is swapped inside it, without a gateway. See [WISP 2xx](../../../../../docs/wisps/2xx-fedimint.md).

## Paying from another wallet

Every request a chat carries, and every invoice or address the Wallet page shows to be paid on, can be paid
by a wallet that is not Ghostly: the payer sees a QR code, the text to copy and a `lightning:` / `bitcoin:`
link (`packages/core/src/paymentUri.ts`, the `PayExternally` component). Settlement is never taken from the
payer: the payee's own source decides, the same way it does when the payer pays through Ghostly:

| Rail | The payee sees it paid through | Then |
|---|---|---|
| Lightning (`btc-lightning-bolt11`) | its Lightning source's `invoiceStatus` (journaled `in` op), or the Cashu wallet's own mint quotes | the request is `settled` and a `pay-res ok` goes to the payer |
| On-chain (`btc-onchain/1`) | `OnchainProvider.received(address)` (or `history` with the payer's txid hint), one confirmation | same |
| Ark (`btc-arkade/1`) | the indexer's virtual outputs on the request's address (`ArkadeAdapter.received`) | same |
| Bark (`btc-bark/1`) | the Bark wallet's receives on the request's address | same |
| Fedimint (`fedimint-ecash/1` with an invoice) | the federation's receive operation of the invoice it made for the request | same |

The payer's copy of the request settles only on that `pay-res` from the payee, never on its own word.
"I paid" sends a `pay` frame with no receipt (the invoice itself, or `{"check":true}` for an address) that
makes the payee's app ask its source now: bounded to one look every few seconds per request, and answered
again with `ok` when the request was already paid. A source without `lookup` still cannot see an invoice
paid, as before.

Opening the link is the platform's job where a plain link cannot do it: the desktop app's `open_payment_link`
command (`lightning:` and `bitcoin:` only), the extension's background page (`chrome.tabs.create`). Copy and
the QR code are always there as the fallback.

## Lightning addresses and LNURL-pay

Paying `name@domain` (LUD-16) or an `lnurl1…` / `lnurlp://` (LUD-01, LUD-17) is resolving a `payRequest`
(LUD-06) and paying the invoice it hands out through the **active Lightning source**, with the same review as
any invoice. The parsing and every check live in `packages/core/src/lnurl.ts`; `LightningService.resolveDestination`
and `destinationInvoice` do the fetching (bounded, no credentials) and keep a resolution while the amount is
chosen. The person is told which domain learns of the request before anything is fetched. The invoice must
be for the exact amount and commit to the metadata shown (`h` = sha256 of it, or the metadata as its
description). In a browser the service must allow CORS; the error names the domain when it does not.
Receiving on a Lightning address needs a server the person runs: not provided. See [WISP 205](../../../../../docs/wisps/205-lnurl.md).

## Testing

- Unit: the fakes in [providers/testing.ts](providers/testing.ts) (`FakeLightningProvider`,
  `FakeOnchainProvider`, `fakeInvoice`, `fakeAddress`) and `packages/browser/test/walletProviders.test.ts`
  show how to drive sources, the journal and the coordinator without a network.
- Contract: `packages/browser/test/providerContract.test.ts` runs the shared contract suite against the
  fakes; run it against your provider too.
- e2e: `localStorage["ghostly-test-providers"] = "1"` (`useFakeProviders(peer)` in `e2e/support/fixtures.ts`)
  adds the fakes to the pickers, in Testnet only. `e2e/web/wallet-sources.spec.ts` drives the picker, the
  Lightning card through a source and the Bitcoin card.
- A provider that loads WebAssembly (BDK) cannot rely on Vite's ESM `.wasm` import: load the glue and
  instantiate the module yourself on first use (see `providers/bdkSdk.ts`), and read the same file from disk in
  Node tests. A mocked HTTP backend given as `fetch` to a WebAssembly client must give its `Response` a `url`
  (see `test/helpers/fakeEsplora.ts`).
- Real networks: gate on `GHOSTLY_<NAME>_REGTEST=1` (for example `GHOSTLY_LND_REGTEST=1`,
  `GHOSTLY_BITCOIND_REGTEST=1`), skip otherwise, and document in `e2e/README.md` what must be running and on
  which ports. Tests never start or stop shared infrastructure, never use real funds, and never print a
  secret.
