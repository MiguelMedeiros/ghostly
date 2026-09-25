# WISP 3xx: Bitcoin Address Proof

| Field | Value |
|---|---|
| Candidate number | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Experimental provider `bitcoin` (`packages/browser/src/proofs/providers/bitcoin.ts`); verifier in `@ghostly/core` |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

An optional proof that the person can sign with the key behind a Bitcoin address. It follows WISP 300's two layers: the person signs, once, in their own wallet, the **binding statement** by which the address authorizes their Ghostly profile key for a validity window; per chat, the app presents that binding with a presentation signed by the profile key and bound to the chat, the contact and a fresh challenge, without asking the wallet again. Sharing stays per contact. The contact's app verifies the address signature over the binding locally, with no network access, no blockchain lookup and no third party. This document covers only the address signature over the binding; the binding and presentation formats are WISP 300's.

**What it does not prove**, and every surface that shows the proof must say so: that the address holds any balance, now or ever; that the person sent or received any past payment; that they would pay, or spend from the address at all. A message signature is also obsolete the moment it is made: the key may be shared, sold or lost later (BIP-322, "Motivation").

## Signature formats

Two formats wallets produce today; a verifier accepts exactly these and nothing looser.

| Format | Pinned reference | Accepted for | Label shown |
|---|---|---|---|
| BIP-322 simple (`smp…`) | [BIP-322 2.0.0](https://github.com/bitcoin/bips/blob/4061a54418f62a5a1ae44f4604e56373329bfad3/bip-0322.mediawiki), bitcoin/bips@4061a54 | P2WPKH, P2TR key path | BIP-322 |
| BIP-322 full (`ful…`) | same | P2WPKH, P2TR key path, P2SH-P2WPKH, P2PKH | BIP-322 |
| Legacy `signmessage` | Bitcoin Core `signmessage`/`verifymessage` | **P2PKH only** (1…, m…, n…) | Legacy |

- **Unprefixed** signatures are read as BIP-322 simple, the BIP's backward-compatibility rule for wallets that predate its 1.0.0 prefixes (Sparrow's older releases, many libraries). A 65-byte base64 value whose first byte is 27 to 42 is read as legacy.
- **Legacy is P2PKH only.** BIP-322 restricts it so ("MUST be restricted to the legacy P2PKH invoice address format"); for SegWit addresses wallets disagree on the header byte (BIP 137 vs Electrum) and the format does not commit to the script. A legacy signature for a SegWit address is refused with a pointer to BIP-322. Headers 35 to 42 (BIP 137 SegWit) are refused.
- **Checked scripts only.** Without a full script interpreter the verifier checks P2WPKH, P2TR key path, P2SH-P2WPKH and P2PKH, applying BIP-322's required rules for them: SIGHASH_ALL (or SIGHASH_DEFAULT for P2TR), strict DER, low S, compressed keys in witness v0, exact `to_sign` shape (one input spending `to_spend:0`, one zero-value `OP_RETURN` output, version 0 or 2). Everything else is **inconclusive**, which a proof treats as not proven: multisig and other P2WSH/P2SH scripts, a Taproot script path whose control block commits to the output key, an annex, witness versions above 1.
- **Proof of funds (`pof…`) is refused**, deliberately: it is the one BIP-322 variant about coins, and this proof makes no claim about coins.
- **Time locks.** The official full vectors set nLockTime and nSequence (BIP-322: "valid at time T and age S"). For the single-key scripts checked, those gate when a real spend could confirm, not who holds the key; the verifier accepts them and reports T and S.
- **Networks.** The verifier takes the mode, Mainnet (`bc1…`, `1…`, `3…`) or Testnet (every test network: `tb1…` testnet3/testnet4/signet/mutinynet, `bcrt1…` regtest, `m…`/`n…`/`2…`), and refuses an address of the other one with a reason naming the mode to switch to. The provider takes the mode from the address itself, since a contact verifies whatever its own wallet mode, and labels a test-network proof "test network" in its short form and its verified source.

## Statement and signing

The signed message is WISP 300's binding statement exactly as shown, with the address as the external identity, in UTF-8. It is signed once per address and profile key, not per chat or contact. Its fields are ASCII, which matters for hardware wallets that restrict message characters. Wallets differ in whether they trim whitespace (Sparrow trims the message), so the statement has none at either end.

Person-facing steps per wallet live in `packages/browser/src/proofs/bitcoinWallets.ts` and are shown filtered by the address type: Sparrow (BIP322 (Simple) for software wallets; hardware wallets there sign only the Electrum format), Bitcoin Core and Electrum (legacy only, so a legacy address), COLDCARD (BIP-322 per its firmware guide), Trezor Suite (legacy, Legacy account), and a generic BIP-322 path.

## Evidence (2026-09-23)

- All official BIP-322 2.0.0 vectors (`basic-test-vectors.json`, `generated-test-vectors.json`, copied unchanged to `packages/core/test/fixtures/bip322/`): message hashes, `to_spend`/`to_sign` ids, every valid simple/full signature of a checked type verifies and fails for another message; every other type is inconclusive; every proof of funds is refused; every error vector is refused (invalid where the script is checked).
- Independent signer: fresh test keys signed with `@scure/btc-signer`, which computes its own BIP 143/341/legacy sighashes, on signet/testnet (`tb`) and regtest (`bcrt`) addresses for all four script types, simple and full; another address, another statement, the other network mode and a high-S signature are refused.
- The provider passes the shared identity-proof contract suite (`describeIdentityProof`) for P2WPKH and P2TR simple, P2SH-P2WPKH and P2PKH full, legacy P2PKH, on signet, regtest and mainnet addresses: own evidence after a JSON trip, every binding field mattering, another key refused, malformed evidence refused, the validity limit, and the share with two contacts including a replay to a third.
- Legacy: signatures from Bitcoin Core v31.0 `signmessage` on regtest legacy addresses, and Bitcoin Core's own `message_verify` example; compressed and uncompressed recovery; SegWit headers refused.

## Open decisions

Hardware wallets' current BIP-322 support and message-length limits per model and firmware (roadmap, "Hardware and signing"); whether to add a script interpreter for multisig; whether the wallet mode should restrict which network's addresses a person may prove (today the address's own prefix decides, and test-network proofs are labelled as such); "sign with my Ghostly wallet", once an on-chain source can sign messages (`OnchainProvider` cannot; Bitcoin Core's `signmessage` is legacy-only), showing the statement and asking first.

## References

[Identity Proofs](300-peer-proofs.md), [BIP-322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki), [BIP 137](https://github.com/bitcoin/bips/blob/master/bip-0137.mediawiki), [BIP 143](https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki), [BIP 341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki), [adapter roadmap](ADAPTER-ROADMAP.md).
