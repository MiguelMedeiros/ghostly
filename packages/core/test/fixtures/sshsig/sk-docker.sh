#!/bin/sh
# Runs generate.sh inside Debian, whose openssh-tests package ships OpenSSH's
# software security-key authenticator (sk-dummy.so), so the sk-ssh-ed25519 and
# sk-ecdsa vectors come from a real ssh-keygen without a hardware key.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$here:/v" node:22-bookworm sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq openssh-client openssh-tests >/dev/null 2>&1
  SK_DUMMY=/usr/lib/openssh/regress/misc/sk-dummy/sk-dummy.so OUT=/v/sshsig-vectors.json sh /v/generate.sh'
