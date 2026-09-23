#!/usr/bin/env bash
# Regenerates the OpenPGP proof test vectors with a real GnuPG (2.2 or later).
# Every key here is a throwaway TEST key made by this script, with no passphrase:
# never use one for anything else, never replace one with a real key.
#
#   bash packages/browser/test/vectors/openpgp/generate.sh
#
# Clocks are faked so the vectors are reproducible in shape and the tests can
# verify at fixed dates: keys are made on 2026-01-01, signatures on 2026-02-01.
# Keys and signatures still differ on every run (fresh randomness).
set -euo pipefail
export TZ=UTC # gpg reads an expiry date as noon, local time
here="$(cd "$(dirname "$0")" && pwd)"
export GNUPGHOME="$(mktemp -d)"
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
chmod 700 "$GNUPGHOME"
out="$here"
statement="$(cat "$here/statement.txt")"
printf '%s' 'Another statement, not the one Ghostly asked for' > "$GNUPGHOME/other.txt"
printf '%s\n' "$statement" > "$GNUPGHOME/statement.txt"

g() { gpg 2> >(grep -v "faked system time" >&2) --batch --yes --no-tty --pinentry-mode loopback --passphrase '' --quiet "$@"; }
at() { local t="$1"; shift; g --faked-system-time "${t}!" "$@"; }
KEYS=20260101T000000
SIGN=20260201T000000
fpr() { g --with-colons --list-keys "$1" | awk -F: '/^fpr/ {print $10; exit}'; }
subfpr() { g --with-colons --list-keys "$1" | awk -F: '/^fpr/ {n++; if (n=='"${2:-2}"') {print $10; exit}}'; }
pub() { at 20260215T000000 --armor --export-options export-minimal --export "$1" > "$out/$2.pub.asc"; }
sec() { g --armor --export-secret-keys "$1" > "$out/$2.sec.asc"; }
clearsign() { local key="$1" name="$2" time="${3:-$SIGN}"; shift 3 || shift $#
  at "$time" --local-user "$key" --clearsign --output "$out/$name.asc" "$@" "$GNUPGHOME/statement.txt"; }

# Alice: Ed25519, certify-only primary, a signing subkey (the YubiKey layout),
# an encryption subkey, and two user IDs of which one is revoked.
at $KEYS --quick-gen-key 'Alice Test <alice@example.org>' ed25519 cert never
A=$(fpr alice@example.org)
at $KEYS --quick-add-uid "$A" 'Alice Old <alice-old@example.org>'
at $KEYS --quick-add-key "$A" ed25519 sign never
at $KEYS --quick-add-key "$A" cv25519 encr never
at 20260102T000000 --quick-revoke-uid "$A" 'Alice Old <alice-old@example.org>'
pub "$A" alice; sec "$A" alice
clearsign "$A" alice-clearsign "$SIGN"
at $SIGN --local-user "$A" --detach-sign --armor --output "$out/alice-detached.asc" "$GNUPGHOME/statement.txt"
at $SIGN --local-user "$A" --detach-sign --textmode --armor --output "$out/alice-detached-text.asc" "$GNUPGHOME/statement.txt"
at $SIGN --local-user "$A" --clearsign --output "$out/alice-other-statement.asc" "$GNUPGHOME/other.txt"
at $SIGN --local-user "$A" --clearsign --digest-algo SHA1 --output "$out/alice-sha1.asc" "$GNUPGHOME/statement.txt"
at $SIGN --local-user "$A" --sign --armor --output "$out/alice-inline.asc" "$GNUPGHOME/statement.txt"

# Bob: RSA 3072, one key that signs with its primary.
at $KEYS --quick-gen-key 'Bob Test <bob@example.org>' rsa3072 sign,cert never
B=$(fpr bob@example.org)
pub "$B" bob; sec "$B" bob
clearsign "$B" bob-clearsign "$SIGN"
# Two signers on one message: refused, a proof names one key.
at $SIGN --local-user "$A" --local-user "$B" --clearsign --output "$out/two-signers.asc" "$GNUPGHOME/statement.txt"

# Carol: ECDSA P-256. Dave: ECDSA brainpoolP256r1.
at $KEYS --quick-gen-key 'Carol Test <carol@example.org>' nistp256 sign,cert never
C=$(fpr carol@example.org); pub "$C" carol; clearsign "$C" carol-clearsign "$SIGN"
at $KEYS --quick-gen-key 'Dave Test <dave@example.org>' brainpoolP256r1 sign,cert never
D=$(fpr dave@example.org); pub "$D" dave; clearsign "$D" dave-clearsign "$SIGN"

# Refused algorithms: RSA below 2048 bits, DSA, and ECDSA on secp256k1.
at $KEYS --quick-gen-key 'Weak Test <weak@example.org>' rsa1024 sign,cert never
W=$(fpr weak@example.org); pub "$W" rsa1024; clearsign "$W" rsa1024-clearsign "$SIGN"
at $KEYS --quick-gen-key 'Dsa Test <dsa@example.org>' dsa2048 sign,cert never
S=$(fpr dsa@example.org); pub "$S" dsa; clearsign "$S" dsa-clearsign "$SIGN"
at $KEYS --quick-gen-key 'K1 Test <k1@example.org>' secp256k1 sign,cert never
K=$(fpr k1@example.org); pub "$K" secp256k1; clearsign "$K" secp256k1-clearsign "$SIGN"

# Erin: expires on 2026-06-01. The signature is made while it is valid.
at $KEYS --quick-gen-key 'Erin Test <erin@example.org>' ed25519 sign,cert 2026-06-01
E=$(fpr erin@example.org); pub "$E" expired; sec "$E" expired; clearsign "$E" expired-clearsign "$SIGN"

# Frank: signs, then revokes his whole key with the certificate gpg made at key
# generation (reason "none given": a hard revocation, which voids every signature). frank-unrevoked.pub.asc is the copy from before the revocation.
at $KEYS --quick-gen-key 'Frank Test <frank@example.org>' ed25519 sign,cert never
F=$(fpr frank@example.org); pub "$F" revoked-unrevoked; sec "$F" revoked; clearsign "$F" revoked-clearsign "$SIGN"
sed 's/^:-----BEGIN/-----BEGIN/' "$GNUPGHOME/openpgp-revocs.d/$F.rev" > "$GNUPGHOME/frank.rev"
at 20260210T000000 --import "$GNUPGHOME/frank.rev"
pub "$F" revoked

# Grace: signing subkey retired on 2026-02-10 (a soft revocation, reason "no longer
# used": signatures before it stay valid). Heidi: signing subkey that expires.
at $KEYS --quick-gen-key 'Grace Test <grace@example.org>' ed25519 cert never
G=$(fpr grace@example.org)
at $KEYS --quick-add-key "$G" ed25519 sign never
clearsign "$G" subkey-revoked-clearsign "$SIGN"
printf 'key 1\nrevkey\ny\n3\n\ny\nsave\n' | gpg --batch --yes --no-tty --pinentry-mode loopback --passphrase '' --quiet \
  --faked-system-time '20260210T000000!' --command-fd 0 --status-fd 3 --edit-key "$G" 3>/dev/null
pub "$G" subkey-revoked
at $KEYS --quick-gen-key 'Heidi Test <heidi@example.org>' ed25519 cert never
H=$(fpr heidi@example.org)
at $KEYS --quick-add-key "$H" ed25519 sign 2026-06-01
pub "$H" subkey-expired; clearsign "$H" subkey-expired-clearsign "$SIGN"

# A key that never signed anything, to paste beside another key's signature.
at $KEYS --quick-gen-key 'Ivan Test <ivan@example.org>' ed25519 sign,cert never
I=$(fpr ivan@example.org); pub "$I" ivan

{
  echo "{"
  printf '  "alice": "%s",\n  "aliceSigningSubkey": "%s",\n' "$A" "$(subfpr "$A" 2)"
  printf '  "bob": "%s",\n  "carol": "%s",\n  "dave": "%s",\n' "$B" "$C" "$D"
  printf '  "expired": "%s",\n  "revoked": "%s",\n  "subkeyRevoked": "%s",\n  "subkeyExpired": "%s",\n  "ivan": "%s"\n' "$E" "$F" "$G" "$H" "$I"
  echo "}"
} > "$out/fingerprints.json"
gpg --version | head -1 > "$out/GENERATED_WITH"
echo "Vectors written to $out"
