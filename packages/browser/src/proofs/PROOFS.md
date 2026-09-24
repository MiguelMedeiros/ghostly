# Identity proofs: providers

An **identity proof** lets a person show a contact, optionally and per contact, that they control an
external identity: a Nostr key, a domain, a Bitcoin address, an SSH or PGP key, an OpenID Connect account.
A **provider** is one kind of identity: how the person produces evidence, and how any Ghostly app checks
it. Everything else is shared and already written: the statement bytes, the proof key, sharing and
withdrawing per contact, replay protection, storage, expiry, re-checks and the UI.

| Category | Who vouches | Examples | Shown as |
|---|---|---|---|
| `self-custodied` | the person: they hold the key, or control the domain | Nostr, SSH, PGP, Bitcoin, domain | "Verified · your key" |
| `provider-attested` | a company that says the person logged in | OpenID Connect (Google, Microsoft, Apple…) | "Verified by accounts.google.com" |

## The model

1. **Made once, in Profile → Identities.** Ghostly creates a fresh Ed25519 **proof key** for the proof (one
   per proof, so two proofs never link to each other; its seed is sealed with a device key like the wallet
   seeds) and builds the **statement**, which names the
   external identity and authorizes that key. The person has the external identity sign or attest it with
   one of the provider's `signers`. Ghostly runs the provider's `verify` on it before saving, so a proof
   that would not verify is never kept. The proof key's seed stays in the profile.
2. **Shared per contact, only when the person chooses** (the chat's Identities control). The contact's app
   sends a fresh challenge; the proof key signs a **presentation** binding the proof to both participation
   keys, the conversation, the session and that challenge; the contact's app checks the presentation,
   then runs the provider's `verify` on the statement and evidence itself, and stores the outcome with its
   scope and time.
3. **Withdrawn** per contact: that contact is told (now, or when it next connects) and shows it as
   withdrawn; future presentations there stop; a copy it kept cannot be erased. **Revoked** by removing it
   from the profile: withdrawn everywhere, and the proof key publishes a revocation record on Pkarr
   (`_ghostly-revoked`, republished until expiry) that contacts find even if the person never reconnects.

Providers produce and verify only the **binding** (external identity → proof key). The per-chat
presentation, withdrawal and revocation are shared code: never re-implement them in a provider.

A copy of what a contact received is useless elsewhere: another contact's challenge is different, the
audience is wrong, and nobody else has the proof key. The external identity itself links every
conversation it is shared in; that is what the person is choosing to reveal, and the UI says so.

This is a delegation (see [WISP 300](../../../../docs/wisps/300-peer-proofs.md#implementation--2026-09-23-identity-proofs)): the external signer authorizes the proof
key once, instead of signing every contact's challenge. It is what makes publish-style (DNS) and
paste-back (SSH, PGP, Bitcoin) proofs usable, and one OpenID login enough for every contact.

## The statement: the exact bytes

`identityStatement(binding)` in `@ghostly/core` (`packages/core/src/identityProofs.ts`) is the only
place the statement is built. It is one line of UTF-8, no trailing newline:

```
Ghostly identity proof v1: I control nostr:3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d and authorize the Ghostly key yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy to present it to contacts I choose, from 2027-01-15T08:00:00Z until 2027-04-15T08:00:00Z. Nonce: AAAAAAAAAAAAAAAAAAAAAA
```

| Field | Rule |
|---|---|
| provider | the provider's `id`, `^[a-z][a-z0-9-]{0,31}$` |
| subject | what `subject.normalize` returns: printable ASCII, no spaces, 1–512 chars (provider-attested: the issuer) |
| key | the proof key, z-base-32 Ed25519 (52 chars) |
| dates | `issuedAt` / `expiresAt` in UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`; at most 400 days apart, and at most the provider's `validity.maxDays` |
| nonce | 16 random bytes, base64url (22 chars) |

- Sign **`statement.text`** (or `statement.bytes`, its UTF-8). Never rebuild it from the binding.
- `statement.id` is SHA-256 of the bytes, lowercase hex: the proof's id in storage and on the wire.
  **OpenID Connect**: use `statement.id` as (or hash it into) the `nonce` of the authorization request, and
  check it in `verify`; the token then attests exactly this statement.
- One line on purpose: no CRLF/LF ambiguity across clipboards, Windows, `gpg`, wallets' message fields.
  Tell people to sign it without adding a newline (`printf '%s' '…' | ssh-keygen -Y sign …`).
- Because the fields never contain spaces and their order is fixed, two different bindings never produce
  the same text; verifiers never parse the text, they rebuild it from the binding they received.

## Adding a provider

1. Write `providers/<name>.ts` exporting an `IdentityProofProvider` ([contract.ts](contract.ts)):

   ```ts
   export const ssh: IdentityProofProvider<SshEvidence> = {
     id: "ssh",                              // stable: in the statement, on the wire, in storage
     label: "SSH key",
     category: "self-custodied",
     summary: "Sign once with ssh-keygen",                       // the picker card: one short line
     description: "Proves you hold an SSH key: sign the statement with ssh-keygen.",  // the details view
     limits: "Does not prove the names in the key's comment.",     // optional: what it does not show
     platforms: ["web", "extension", "desktop"],
     subject: { label: "Public key", placeholder: "ssh-ed25519 AAAA…", normalize: canonicalSshKey, short: fingerprint },
     validity: { defaultDays: 90, maxDays: 365 },
     privacy: "Nothing: the signature is checked on this device.",
     signers: [{ id: "ssh-keygen", kind: "external-tool", label: "ssh-keygen",
       instructions: s => ({ steps: [{ text: "Run:", copy: `printf '%s' '${s.text}' | ssh-keygen -Y sign -n ghostly -f ~/.ssh/id_ed25519` }],
                            paste: { label: "Signature", placeholder: "-----BEGIN SSH SIGNATURE-----", multiline: true } }),
       parse: pasted => parseSshSig(pasted) }],
     parseEvidence: raw => strictSshEvidence(raw),
     async verify(statement, evidence, ctx) { /* check the SSHSIG over statement.bytes, namespace "ghostly" */ return { subject: statement.binding.subject, source: "SSH signature (SSHSIG, namespace ghostly)" }; },
   };
   ```

2. Add it to `IDENTITY_PROVIDERS` in [registry.ts](registry.ts), the order is the picker's, and give it a
   mark in `src/components/identities/ProviderIcons.tsx` (`identityProviderIcons.test.tsx` fails for a provider without one).
   Those are the only shared lines you touch.
3. Tests: run `describeIdentityProof` from `packages/browser/test/helpers/identityProofContract.ts` against
   your provider (see [identityProofContract.test.ts](../../test/identityProofContract.test.ts)), plus your
   own: real tool output as vectors, every malformed shape of your format, your network answers.
4. Add a row to the table at the end of this file, and to WISP 300's implementation section.

The UI renders every provider from its descriptor: the picker card (label, summary, category, its mark from
`src/components/identities/ProviderIcons.tsx`), the details view (description, limits), the subject
field (`subject`), the validity choice (`validity`), the signer flow by `kind`, the badges (`short`,
`category`, `source`, `attester`). No component to write.

### Signers: how the evidence is made

A provider has one or more signers; the UI shows the ones whose `platforms` include this one and whose
`available()` is true. They run in the UI (renderer), never in the engine.

| `kind` | For | The UI | You write |
|---|---|---|---|
| `in-app` | a signer Ghostly can call: NIP-07, NIP-46, a wallet API | renders `fields`, calls `run`, shows `onAuthUrl` as a link (never opens it) and `onProgress` | `run(ctx, work)`: open, hand `work` a session with `subject()` and `sign(statement)`, always clean up |
| `external-tool` | ssh-keygen, gpg, a Bitcoin wallet's "sign message" | shows `instructions(statement)` with copy buttons and a paste field | `instructions`, `parse(pasted)` |
| `redirect` | OpenID Connect | "Continue" prepares the statement; a second button calls `start(statement, ctx)` **synchronously from its click** (nothing awaited before it, so the popup keeps the user activation) | `start` (PKCE, `nonce` from `statement.id`, `state`, popup): open the popup before any `await` |
| `publish` | DNS TXT, `/.well-known/…` | shows `instructions(statement)`, then "Check" | `instructions`, `evidence` (often `{}`: the verifier looks it up) |

For `in-app`, the subject comes from the signer (`session.subject()`); for the others the person types or
picks it in the subject field. For `redirect`, the subject in the statement is the issuer, and the account
comes out of `verify`.

### `verify`

`verify(statement, evidence, ctx)` returns a `VerifiedIdentity` or throws a short message a person can
read ("The record is not published"). The shared `verifyIdentity` (in [verify.ts](verify.ts)) wraps it,
so you do not repeat these, but you must not contradict them:

- The provider must be known here, the validity within `validity.maxDays`, the evidence at most 16 KiB of
  JSON, and `parseEvidence` must accept it: **strict** — exact keys, bounded strings, no extra fields.
- `self-custodied`: return `subject === statement.binding.subject`. `provider-attested`: return the
  attested account as `subject` (`https://accounts.google.com#1234…`, printable ASCII ≤ 512) and set
  `attester` (the issuer host).
- `source` says how it was checked, for people. `expiresAt` when the evidence expires before the binding
  (a PGP key's expiry). `display` only for name/picture the evidence itself carries (OIDC `name` claim),
  with its `source`; avatars must already be sanitized `data:image/png|jpeg` URLs.
- Use `ctx.now` (seconds) for time and `ctx.signal` for cancellation.
- Results are bounded again by `boundVerifiedIdentity` in core (lengths, control characters, https URLs).

The same `verify` runs twice: on the person's device before saving, and on each contact's device when it
is shared. The contact's app never trusts the sender's check.

## Network fetches and privacy

- `verify` reaches the network **only** through `ctx.fetch` (never the global `fetch`; the contract suite
  fails a provider that does). The engine's `ctx.fetch` is HTTPS GET only, no cookies or credentials, no
  referrer, a 10 s time-out, `maxBytes` (default 64 KiB), and refuses everything when the person turned
  the network off. Redirects are refused unless you pass `redirect: "follow"`. It returns `text` and the
  raw `bytes` (for binary answers such as DNS-over-HTTPS `application/dns-message`).
- Write in `privacy` who learns what: "The contact's app asks cloudflare-dns.com for the TXT record of
  your domain: that resolver learns the domain was checked." The UI shows it before the person shares.
- Fetch only fixed, well-known endpoints or ones derived from the subject (the domain itself, the issuer's
  JWKS from its discovery document on the issuer's own host). Never a URL from the evidence.
- `lookupDisplay` (optional: a public name/picture for a verified subject, like Nostr kind-0) runs **only
  when the person asks**, never automatically; `lookupLabel` names its button. A name is always shown with
  its `source` right under it, so say plainly what it is and who checked it ("User ID on the key, written by
  its holder"). A name never replaces the contact's chat name. Sanitize like avatars (plain-text name, bounded raster,
  re-encoded to a data URL; see `profiles/public.ts`).

## Expiry and re-checks

- Every proof expires (`expiresAt`); both sides show it as expired afterwards, never as verified. The person
  makes a new one; sharing it replaces the contact's copy of the same identity.
- Early revocation is shared: "Check again" (offered for every provider) looks up the proof key's Pkarr
  revocation record first, and the app does so every 12 hours by itself. A revoked proof shows "Revoked by
  its owner".
- A signature stays valid until expiry. A **published** record can disappear sooner: declare
  `recheck: { afterSeconds }`. The contact's app shows when it last checked and always offers "Check again"
  (`recheckDue` marks it due after that time), and shows a failed re-check honestly ("Could not be confirmed
  on …"), without deleting the proof. `describeIdentityProof` then requires the harness to have `revoke()`.

## On the wire

Additive: the paired offer carries `identity-proof/1`; old apps do not, and their contacts see no
Identities control for them (they are simply unverified). Frames, JSON over the authenticated paired
channel, at most 32 KiB each:

| Frame | From | Fields |
|---|---|---|
| `idp-hello` | both, when ready | `providers`: the ids this app can verify |
| `idp-request` | sharer | `id` (statement id), `provider` |
| `idp-challenge` | verifier, after saving the nonce | `id`, `nonce` (32 bytes, base64url), `issuedAt` |
| `idp-present` | sharer | `nonce`, `issuedAt`, `binding`, `evidence`, `sig` (proof key over the presentation) |
| `idp-result` | verifier, after saving the outcome | `id`, `ok`, `error?` |
| `idp-withdraw` / `idp-withdrawn` | sharer / verifier | `id` |

The presentation the proof key signs is the UTF-8 JSON
`["ghostly-identity-presentation",1,id,presenterParticipationKey,verifierParticipationKey,conversationHash,sessionHash,nonce,issuedAt]`.
A challenge is single-use, answered within 300 s, at most 8 outstanding per conversation; consuming it and
storing the outcome are one transaction.

## Testing

- **Contract**: `describeIdentityProof(name, make)` with a harness: `provider`, a `subject` you control,
  `prove(statement)` (how your signer would), `proveAsOther` (another key/account: must fail), `fetch` (your
  stubbed network), `revoke` (with `recheck`). It checks the descriptor, own evidence after a JSON trip,
  `ctx.fetch` only, every binding field mattering, malformed evidence, the validity limit, the full share
  with two contacts including a replay to a third, and re-checks.
- **Fakes** ([testing.ts](testing.ts)): `fake-key` (in-app and external-tool), `fake-account` (attested,
  redirect), `fake-record` (published, re-checked). In the app only when
  `localStorage["ghostly-test-identities"] === "1"`.
- **e2e**: two peers (`e2e/support/fixtures.ts`), a test signer injected in the page (for Nostr, a NIP-07
  `window.nostr` backed by a key in the test process: `e2e/web/identity-proofs.spec.ts`); never a real
  account. `e2e/web/identity-proof-kinds.spec.ts` drives the paste-back and redirect flows with the fakes.
  Test ids: Profile `identity-add` → `add-identity` with `add-identity-<provider>`, `add-identity-signer`,
  `add-identity-subject`, `add-identity-validity`, `add-identity-field-<name>`, `add-identity-start`, then
  `add-identity-copy-<step>`, `add-identity-paste`, `add-identity-finish`, `add-identity-error`; saved rows
  `identity-proof`. Chat: Options → `chat-identities-open` → `chat-identities` with `chat-identity-share`,
  `chat-identity-withdraw`, `chat-identity-mine-status`, `chat-identity-received` (`data-status`),
  `chat-identity-recheck`, `chat-identity-lookup`; header `chat-identity-badges`.
- Real services: gate on `GHOSTLY_<NAME>_LIVE=1`, skip otherwise; never a person's real account or key.
  Never print or commit a private key.

## Providers

| id | Category | Signers | `verify` contacts | Status |
|---|---|---|---|---|
| `nostr` | self-custodied | NIP-07 extension, NIP-46 remote signer | nothing (profile, follows and notes: the [social layer](../../../../docs/wisps/3xx-nostr-social.md), from the person's relays, on request) | shipped |
| `domain` | self-custodied | DNS TXT record, `/.well-known/ghostly.json` (publish); NIP-05 with a NIP-07/NIP-46 signer | the chosen DNS-over-HTTPS resolver; for the file methods also the domain's web server | experimental, [draft 3xx](../../../../docs/wisps/3xx-domain.md) |
| `openpgp` | self-custodied | gpg (paste signature and key), gpg with the key from keys.openpgp.org | nothing (`lookupDisplay`, on request: keys.openpgp.org) | shipped; [WISP 3xx](../../../../docs/wisps/3xx-openpgp.md) |
| `bitcoin` | self-custodied | the person's wallet: Sparrow, Bitcoin Core, Electrum, COLDCARD, Trezor Suite, another BIP-322 wallet (paste) | nothing | experimental: BIP-322 2.0.0 + legacy P2PKH, [draft 3xx](../../../../docs/wisps/3xx-bitcoin.md) |
| `ssh` | self-custodied | `ssh-keygen -Y sign -n ghostly` (external tool) | nothing | experimental |
| `ssh-github` | self-custodied | same | `api.github.com/users/<login>/keys`; re-checked after 10 min | experimental |
| `ssh-gitlab` | self-custodied | same | `gitlab.com/api/v4/users?username=` then `/users/<id>/keys`; re-checked after 10 min | experimental |
| `oidc` | provider-attested | redirect: sign in with Google, Microsoft, Apple, GitLab, Twitch (account only / + email / + email and name) | the provider's JWKS (pinned URL) | in development; no client ID registered yet ([checklist](../../../../docs/OIDC-PROVIDERS.md), [draft](../../../../docs/wisps/3xx-oidc-proofs.md)) |
