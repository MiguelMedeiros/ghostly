# Wallets and payments

How wallets are organised, which rails run on which network, and how money moves in a chat. Specs: [WISP 200 Payment Negotiation](wisps/200-payments.md) and the rail WISPs below. Writing a Lightning or on-chain source: [PROVIDERS.md](../packages/browser/src/engine/paymentAdapters/PROVIDERS.md).

## Wallets per network

- There are two networks: **Mainnet** (real money) and **Testnet** (test coins, worth nothing). There is no global mode: every wallet belongs to one network, and both are open at once (#276, #286).
- A wallet is one kind on one network, id `<type>:<network>` (`packages/browser/src/engine/paymentAdapters/walletInstances.ts`). Lightning has one wallet per card: `lightning:<network>:<card>`.
- Kinds: Cashu, Lightning, Ark, Bark, Spark, Bitcoin, Fedimint, USDT (`WALLET_TYPES`).
- Any test chain (signet, mutinynet, regtest, Sepolia, the test mint) counts as Testnet. Test coins and real money never mix.

## The Wallets page

Route `/wallet` (`apps/ui/src/pages/Wallet.tsx`).

- **Mainnet | Testnet tabs** (#304, `apps/ui/src/components/wallet/NetworkTabs.tsx`). Each tab shows its network's deck. The tab only chooses what is shown; every card pays on its own network.
- **The deck**: one card per wallet (`apps/ui/src/components/WalletDeck.tsx`, deck mechanics in `apps/ui/src/components/deck/`, shared with the identity cards). The chosen card's panel sits below it: receive, send, options, Remove.
- **New** in the header (#277, #288) opens a picker: network first (Real money / Test money), then a kind. Each kind says what clicking does ("Create", "Create…" (Spark on Mainnet asks for a Breez API key first), "Connect…", "Add another…", "Join with invite…", "Added", "Not yet"). Once made, the dialog closes and the new card is dealt in, selected (#309). A new Mainnet Bark wallet opens on its backup rows first.
- **Remove** (#288) sits in the chosen wallet's panel. See [Removal](#removal-protects-money-in-flight).
- **Backup reminder** (#693, `packages/browser/src/shared/backupReminder.ts`, `apps/ui/src/components/wallet/BackupReminder.tsx`). The first time a Mainnet wallet holds money, a card above the deck and a dot on the wallet icon ask once for a copy: the recovery phrase for a phrase wallet (USDT, Ark, Bark, Spark, Fedimint), a profile backup for Cashu. A phrase shown, a wallet backup file, or a profile backup made after the money arrived ends it. Later puts it off until the next receive or three days, once. The engine keeps it per wallet in the profile's settings (`backupReminders`). Testnet never asks.

## Lightning cards

A network can hold several Lightning cards, each with its own source, balance and journal (#314, #317, `providers/lightningCards.ts`).

- One card is the **Default for receiving** (a switch in the card's settings, "Default" on its face). Requests and Receive use it unless a card is named.
- The Cashu mints' card is at most one per network, shown while the network has mints.
- Migration: the source a network had before cards became card `main` under the same storage key, so no secret moves. No source meant the mints' card.
- The same wallet twice is refused. A card with a payment still in flight cannot be removed.

## Rails and networks

Files under `packages/browser/src/engine/paymentAdapters/`.

| Rail | Mainnet | Testnet | Code | Spec |
|---|---|---|---|---|
| Cashu | minibits, 21mint.me, mountainlake (mints hold the sats) | testnut.cashu.space | `cashu.ts`, `../wallet.ts` | [201](wisps/201-cashu.md) |
| Lightning: Cashu mints | yes | yes | `providers/cashuMint.ts` | [203](wisps/203-lightning.md) |
| Lightning: NWC | yes | testnet, signet, mutinynet, regtest | `providers/nwc.ts` | [203](wisps/203-lightning.md) |
| Lightning: LND | yes | testnet, signet, regtest | `providers/lnd.ts` | [203](wisps/203-lightning.md) |
| Lightning: Core Lightning | yes | testnet, signet, regtest | `providers/coreLightning.ts` | [203](wisps/203-lightning.md) |
| Lightning: WebLN (web only) | yes | yes | `providers/webln.ts` | [203](wisps/203-lightning.md) |
| Lightning: Breez (Spark) | yes (your Breez API key) | regtest | `providers/breez.ts` | [203](wisps/203-lightning.md) |
| Ark (Arkade) | arkade.computer | Mutinynet (mutinynet.arkade.sh) | `arkade.ts`, `arkWallet.ts` | [202](wisps/202-arkade.md) |
| Bark (Second) | ark.second.tech (#305; Second's terms apply) | signet (ark.signet.2nd.dev) | `bark.ts`, `barkWallet.ts` | [204](wisps/204-bark.md) |
| Spark | yes (your Breez API key, asked by New) | regtest | `spark.ts`, `sparkWallet.ts` | [2xx](wisps/2xx-spark.md) |
| Fedimint | yes: federations on Bitcoin, joined by invite code | federations on test networks, joined by invite code | `fedimint.ts`, `fedimintWallet.ts` | [2xx](wisps/2xx-fedimint.md) |
| Bitcoin: BDK | not offered | signet, mutinynet, regtest (Esplora) | `providers/bdk.ts` | [200](wisps/200-payments.md) |
| Bitcoin: Bitcoin Core (Desktop only) | yes | testnet, signet, regtest | `providers/bitcoind.ts` | [200](wisps/200-payments.md) |
| USDT | Ethereum | Sepolia test USDT | `usdt.ts`, `usdtWallet.ts` | [USDT-INTEGRATION.md](USDT-INTEGRATION.md) |

Also:

- **Lightning addresses and LNURL-pay** are paid through the active Lightning source; they are not a wallet ([WISP 205](wisps/205-lnurl.md), `apps/ui/src/components/wallet/LightningAddressPay.tsx`).
- **Pay with another wallet**: a request can be paid from any external wallet by QR, copied text or a `lightning:`/`bitcoin:` link, then "I paid". The payee's own source decides whether it was paid (`apps/ui/src/components/PayExternally.tsx`).

## Testnet: Get test coins

- A Testnet wallet's panel has **Get test coins** (#291, `apps/ui/src/components/wallet/TestCoins.tsx`). It never shows on Mainnet.
- Cashu (and Lightning through the mints): 10,000 test sats from the test mint. USDT: 1,000 test USDT from Aave's Sepolia faucet (needs a little Sepolia ETH for gas).
- Faucets behind a login or CAPTCHA (Mutinynet, Second's signet, Lightspark regtest, signet, testnet4) get an "Open faucet" link. Ghostly never solves a CAPTCHA.
- Receive never fills itself: an invoice on a test mint that pays its own invoices is held until a payer says "I paid".

## Mainnet: confirm real money

- Every Mainnet spend asks a second step, **Send real money**, with Back focused (#298, `apps/ui/src/components/ConfirmRealMoney.tsx`). Testnet stays one step.
- The engine enforces it too: `approvePayment`, `payRequest`, `walletPayQuote` and `sendPayment` refuse a Mainnet spend without `confirmedReal` (`assertConfirmedReal`).
- Ecash for a request is spent only from mints of the request's network.

## Removal protects money in flight

Removing a wallet checks what it still waits for, not only its balance (#303, `packages/browser/src/engine/walletAwaiting.ts`).

- Counted: open invoices, invoices paid and not claimed yet, ecash issued and not claimed, open Lightning receives, requests only this wallet can be paid through, and ecash sent and not taken yet.
- Money already paid is claimed first (bounded to 30 s). If something still waits, the dialog lists it and removal needs its "I understand: …" box ticked (`acceptLoss`).
- Open requests are closed, and the contact gets `pay-res` with `c: true`: their bubble stops offering Pay. A contact offline at that moment is not told.

## Payments in a chat

- **+ → Payment** opens the payment sheet, a deck of your cards with two modes: **Pay or request** and **Accept** (#263, `apps/ui/src/components/PaymentComposer.tsx`).
- **Accept** (`apps/ui/src/components/ChatPaymentAccept.tsx`): each wallet on each network is a switch. A way of paying works only when both sides have it on. Lightning shows the network's default card.
- **Mainnet | Testnet tabs** in the sheet (#307). The starting tab is per chat: last used, else the one network the contact takes, else Mainnet (`apps/ui/src/lib/chatPayments.ts`). The sheet closes after a payment or a request.
- "‹ Cards" or Escape steps back from a turned card (#296).
- Groups: pay one member or everyone, with Cashu or Lightning (`apps/ui/src/components/GroupPaymentComposer.tsx`).

## Money in messages

Payment strings in a message become cards (#284, `apps/ui/src/lib/money.ts`, `apps/ui/src/lib/parse/money-*.ts`, `apps/ui/src/components/MoneyFormatsBubble.tsx`):

- BIP 21 `bitcoin:` links, bare Bitcoin addresses (checksum checked)
- BOLT 11 invoices, BOLT 12 offers (copy or open only: no wallet here pays offers yet)
- Lightning addresses (a message of just the address) and LNURL
- Cashu tokens and Cashu payment requests
- Ark addresses (`ark1`/`tark1`, Arkade or Bark)
- USDT: `ethereum:` links, or a `0x…` address next to "USDT"

## Secret guard

Before a message is sent, the composer asks when the text looks like a secret (#283, `apps/ui/src/lib/parse/secrets.ts`, `apps/ui/src/components/SecretGuardDialog.tsx`):

- a BIP 39 seed phrase (valid checksum), an `nsec`, an extended private key or WIF, a 64/128-character hex key next to a word like "seed" or "private key", a Cashu token (with its amount).
- Cancel has the focus. The other button says "Send anyway", or "Send" for a Cashu token.
