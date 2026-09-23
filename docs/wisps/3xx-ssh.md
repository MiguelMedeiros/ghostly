# WISP 3xx — SSH keys

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Experimental provider `ssh`; see below |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

An optional identity proof, under [300](300-peer-proofs.md), that a person controls an SSH key: the key signs the WISP 300 statement with OpenSSH's own tool, and a contact's app verifies the signature locally. Optionally, the proof names a GitHub or GitLab account; the contact's app then checks that the account publishes that key. Nothing here uses the key for SSH authentication, and a signature never grants a server login.

## Producing the evidence

The person runs `ssh-keygen -Y sign` (OpenSSH 8.1 or later) with namespace **`ghostly`** on the exact statement bytes, without a trailing newline, and pastes the armored output:

```
printf '%s' '<statement>' | ssh-keygen -Y sign -n ghostly -f ~/.ssh/id_ed25519
```

The app shows this command with the statement filled in and a copy button, refusing to build it if the statement would need shell escaping. `-f` may name a public key whose private half lives in `ssh-agent` (a hardware token, a password manager's agent). Windows users without a POSIX shell can save the statement to a file and run `ssh-keygen -Y sign -n ghostly -f <key> <file>`, then paste `<file>.sig`; a single trailing newline added by an editor is accepted, nothing else is.

The private key never enters Ghostly. The namespace keeps these signatures from being valid anywhere else: a `git` commit signature or a `file` signature over the same bytes is refused, and a `ghostly` signature is useless to Git or `ssh-keygen -Y verify -n file`.

## Evidence and verification

Provider id `ssh`. Subject: the key's SHA-256 fingerprint exactly as `ssh-keygen -l` prints it (`SHA256:` and 43 unpadded base64 characters). The person enters their public key (a `.pub` line); the fingerprint is computed from it.

Evidence, strict JSON with no other members:

```
{ "signature": "-----BEGIN SSH SIGNATURE-----\n…\n-----END SSH SIGNATURE-----\n",
  "accounts": { "github": "<login>", "gitlab": "<username>" } }   // accounts and each member optional
```

The verifier, per [PROTOCOL.sshsig](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig):

1. Armor: the exact `BEGIN`/`END SSH SIGNATURE` lines around canonical base64 (surrounding whitespace and CRLF tolerated); at most 6144 characters.
2. Envelope: magic `SSHSIG`, version 1, the public key, namespace, an **empty** reserved field, hash algorithm `sha512` or `sha256`, the signature; every length bounded, no trailing bytes.
3. Namespace equals `ghostly`.
4. The embedded public key parses strictly and its fingerprint equals the proof's subject.
5. The key signed `"SSHSIG" ‖ string(namespace) ‖ string("") ‖ string(hash) ‖ string(H(statement))`, where `H(statement)` is over exactly the statement bytes (or the statement followed by one newline, see above).

Key types and signature algorithms:

| Key | Signature | Notes |
|---|---|---|
| `ssh-ed25519` | Ed25519, RFC 8032 strict (no ZIP-215) | |
| `ecdsa-sha2-nistp256` / `384` / `521` | ECDSA with SHA-256 / 384 / 512 | canonical positive mpints; high-S accepted, as OpenSSH does |
| `ssh-rsa` | `rsa-sha2-512` or `rsa-sha2-256` | 2048–8192-bit moduli; `ssh-rsa` (SHA-1) signatures refused |
| `sk-ssh-ed25519@openssh.com` | Ed25519 over `SHA256(application) ‖ flags ‖ counter ‖ SHA256(message)` | FIDO security keys (YubiKey and others) |
| `sk-ecdsa-sha2-nistp256@openssh.com` | ECDSA P-256 over the same | |

Security-key signatures must carry the user-presence flag: a key created with `-O no-touch-required` signs without a touch, and such a signature is refused. The user-verified flag (PIN or biometric) is recorded but not required. The signature counter is not tracked: there is no shared counter state between contacts.

## GitHub and GitLab, without OAuth

Both forges publish every account's SSH authentication keys: `https://api.github.com/users/<login>/keys` and, on GitLab, `https://gitlab.com/api/v4/users?username=<username>` then `/api/v4/users/<id>/keys`. Both answer cross-origin requests (`Access-Control-Allow-Origin: *`); `github.com/<login>.keys` and `gitlab.com/<username>.keys` do not, so browsers cannot use them.

If the evidence names an account and that account's published keys include the signing key, the contact's app shows "GitHub: <login> (via published SSH key)". Only the account holder can add a key to their account, so this links the account to the key, and the proof links the key to the Ghostly profile. The claim is otherwise worth nothing: an account that does not list the key shows "does not list this key", and the proof of the key itself is unaffected.

- The lookup is the verifier's, through the engine's bounded fetch: HTTPS only, no credentials or referrer, a 10-second time-out, 256 KiB and 200 keys at most per response, key types Ghostly cannot verify ignored.
- It reveals to GitHub or GitLab, and to the network, that this device asked about that account. The provider's privacy line says so before the person shares or checks.
- The result is re-checked: a listing is cached for ten minutes, and the contact's app offers "Check again" after that; a key removed from the account stops showing the link on the next check. Unauthenticated GitHub requests are rate limited (60 per hour per IP address); a failed lookup shows "could not be checked", never a link.
- Deploy keys, signing keys and GitHub Enterprise or self-hosted GitLab instances are out of scope.

## Security considerations

- An SSH key proves control at signing time, not a civil identity. The same key across contacts links those conversations, and a forge account links them publicly.
- SSH keys are often long-lived and shared across machines; a stolen key can make a valid proof. Security keys with user presence narrow this.
- Parsing is bounded before any cryptography runs; malformed input fails closed and never affects the chat.

## Conformance

Test vectors made with a real `ssh-keygen` (OpenSSH 9.2p1, Debian, and 9.9p2, macOS), including security-key signatures from OpenSSH's software authenticator, are in [`packages/core/test/fixtures/sshsig/`](../../packages/core/test/fixtures/sshsig/), with the script that regenerates them. A verifier accepts every vector over the fixture's statement and refuses: another statement, the `git` namespace, a tampered signature, a swapped key, a non-empty reserved field, another version or hash, trailing bytes, an `ssh-rsa` (SHA-1) signature, an RSA key under 2048 bits, and a security-key signature without user presence.

## References

[WISP 300](300-peer-proofs.md), [PROTOCOL.sshsig](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig), [PROTOCOL.u2f](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f), [ssh-keygen(1)](https://man.openbsd.org/ssh-keygen), [GitHub: list public keys for a user](https://docs.github.com/en/rest/users/keys#list-public-keys-for-a-user), [GitLab: list SSH keys for a user](https://docs.gitlab.com/api/user_keys/).
