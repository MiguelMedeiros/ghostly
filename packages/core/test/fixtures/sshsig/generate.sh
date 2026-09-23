#!/bin/sh
# Regenerates sshsig-vectors.json with a real OpenSSH ssh-keygen and throwaway
# keys created in a temporary directory. Private keys never leave that
# directory and are deleted on exit; only public keys and signatures are kept.
#
#   sh packages/core/test/fixtures/sshsig/generate.sh
#
# Security-key (sk-*) vectors need OpenSSH's software authenticator from its
# regression suite; set SK_DUMMY=/path/to/sk-dummy.so to include them (the
# committed ones came from Debian's openssh-tests package, see sk-docker.sh).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
message='["ghostly-peer-proof",1,"control-of-external-key","ssh","test-vector","subject","audience","context","session","nonce",1800000000,1800086400]'
printf '%s' "$message" > "$work/message"
printf '%s' 'a different statement' > "$work/other"

entry() { # name, key file, extra sign options
  name=$1; key=$2; shift 2
  ssh-keygen -Y sign -q -n ghostly -f "$key" "$@" < "$work/message" > "$work/$name.sig"
  ssh-keygen -Y sign -q -n git -f "$key" < "$work/message" > "$work/$name.git.sig"
  # Self-check with ssh-keygen's own verifier before anything is written.
  printf 'test %s\n' "$(cat "$key.pub")" > "$work/allowed"
  ssh-keygen -Y verify -q -f "$work/allowed" -I test -n ghostly -s "$work/$name.sig" < "$work/message" > /dev/null
  node -e '
    const fs = require("fs"); const [name, pub, sig, git] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ name, publicKey: fs.readFileSync(pub, "utf8").trim().split(" ").slice(0, 2).join(" "),
      signature: fs.readFileSync(sig, "utf8"), otherNamespace: fs.readFileSync(git, "utf8") }));' \
    "$name" "$key.pub" "$work/$name.sig" "$work/$name.git.sig" >> "$work/entries"
  printf ',\n' >> "$work/entries"
}

: > "$work/entries"
for spec in ed25519: ecdsa:256 ecdsa:384 ecdsa:521 rsa:2048 rsa:3072; do
  type=${spec%%:*}; bits=${spec#*:}
  ssh-keygen -q -t "$type" ${bits:+-b "$bits"} -N '' -C '' -f "$work/$type$bits"
done
entry ed25519 "$work/ed25519"
entry ed25519-sha256 "$work/ed25519" -O hashalg=sha256
entry ecdsa-p256 "$work/ecdsa256"
entry ecdsa-p384 "$work/ecdsa384"
entry ecdsa-p521 "$work/ecdsa521"
entry rsa-2048 "$work/rsa2048"
entry rsa-3072-sha256 "$work/rsa3072" -O hashalg=sha256
if [ -n "${SK_DUMMY:-}" ]; then
  export SSH_SK_PROVIDER="$SK_DUMMY"
  ssh-keygen -q -t ed25519-sk -N '' -C '' -f "$work/ed25519sk"
  ssh-keygen -q -t ecdsa-sk -N '' -C '' -f "$work/ecdsask"
  entry sk-ed25519 "$work/ed25519sk"
  entry sk-ecdsa-p256 "$work/ecdsask"
  ssh-keygen -q -t ed25519-sk -O no-touch-required -N '' -C '' -f "$work/notouch"
  entry sk-ed25519-no-touch "$work/notouch"
fi
{
  printf '{\n"generator": "%s",\n"namespace": "ghostly",\n' "$(ssh -V 2>&1)"
  node -e 'process.stdout.write("\"message\": " + JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")) + ",\n")' "$work/message"
  printf '"vectors": [\n'
  sed '$ s/,$//' "$work/entries"
  printf '\n]\n}\n'
} > "${OUT:-$here/sshsig-vectors.json}"
