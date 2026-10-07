#!/usr/bin/env bash
# Sets up Ghostly's official store once, on the owner's own machine (WISP 1200, "Stores"; docs/APPS.md).
#
#   tools/scripts/store-keys.sh [--keys <dir>] [--store <dir>]
#
# It makes two new Ed25519 keys in <dir> (default ~/ghostly-keys, owner-only):
#   store.key            signs the store index (ghostly store sign). Never signs an app.
#   chess-publisher.key  signs the Chess bundle (ghostly app publish). Never signs a store.
# then builds the Ghostly CLI and Chess (apps/mini/chess) from this checkout, publishes Chess with its publisher key
# into a clone of github.com/MiguelMedeiros/ghostly-store (--store, default ../ghostly-store beside this checkout,
# cloned when missing), writes its listing, builds the first index and signs it with the store key, and checks the
# result as the store's CI does.
#
# It prints the two PUBLIC keys and their fingerprints and the next steps. It never prints a private key, never
# pushes, and refuses to run when either key file is already there.
#
# Tests may set GHOSTLY_CLI (a built ghostly.mjs) and CHESS_DIST (a built Chess dist/) to skip the builds, and
# STORE_SKIP_CHECK=1 to skip the store's own check.
set -euo pipefail
umask 077

STORE_REPO="MiguelMedeiros/ghostly-store"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
keys="$HOME/ghostly-keys"
store="$(dirname "$repo")/ghostly-store"

die() { echo "store-keys: $*" >&2; exit 1; }
usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --keys) [[ $# -ge 2 ]] || die "--keys needs a folder"; keys="$2"; shift 2 ;;
    --store) [[ $# -ge 2 ]] || die "--store needs a folder"; store="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

command -v node >/dev/null || die "node is needed (22.12 or later)"
command -v git >/dev/null || die "git is needed"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
  || die "node 22.12 or later is needed"

# ---------- the key folder: new, owner-only, outside any git repository ----------

store_key="$keys/store.key"
publisher_key="$keys/chess-publisher.key"
for key in "$store_key" "$publisher_key"; do
  [[ -e "$key" ]] && die "$key is already there. This script makes new keys only, and never over a key: a store is its key, and an app is updated only with the key that signed it. To sign again with the keys you have, see docs/APPS.md"
done
probe="$keys"
while [[ ! -e "$probe" ]]; do probe="$(dirname "$probe")"; done
if git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "$keys is inside a git repository: keep the keys out of every repository (the default is ~/ghostly-keys)"
fi
mkdir -p "$keys"
chmod 700 "$keys"
keys="$(cd "$keys" && pwd)"
store_key="$keys/store.key"
publisher_key="$keys/chess-publisher.key"

# ---------- the store's clone: the layout of ghostly-store, never signed before ----------

if [[ ! -e "$store" ]]; then
  echo "Cloning github.com/$STORE_REPO into $store"
  git clone --quiet "https://github.com/$STORE_REPO.git" "$store"
fi
store="$(cd "$store" && pwd)"
[[ -f "$store/store.json" && -f "$store/STORE_KEY" ]] || die "$store is not a clone of github.com/$STORE_REPO (no store.json and STORE_KEY)"
[[ -z "$(tr -d '[:space:]' < "$store/STORE_KEY")" && ! -e "$store/ghostly-store.json" ]] \
  || die "$store is signed already (STORE_KEY or ghostly-store.json is there): this script sets the store up once. To sign again, see docs/APPS.md"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Runs the CLI with its JSON answer on stdout; on a refusal prints the CLI's error (which never holds a key) and stops.
cli_json() {
  local out
  if ! out="$(node "$cli" "$@" 2>"$work/cli.err")"; then
    cat "$work/cli.err" >&2
    [[ -n "$out" ]] && echo "$out" >&2
    die "ghostly $1 $2 failed"
  fi
  printf '%s' "$out"
}
field() { node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(String(v[process.argv[2]]))' "$1" "$2"; }

# ---------- builds ----------

commit="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "${GHOSTLY_CLI:-}" ]]; then cli="$GHOSTLY_CLI"; else
  [[ -d "$repo/node_modules" ]] || (cd "$repo" && npm ci --no-audit --no-fund)
  echo "Building the Ghostly CLI at $commit"
  (cd "$repo" && npm run build -w @ghostlytools/cli >"$work/build.log" 2>&1) || { cat "$work/build.log" >&2; die "the CLI did not build"; }
  cli="$repo/packages/cli/dist/ghostly.mjs"
fi
if [[ -n "${CHESS_DIST:-}" ]]; then chess_dist="$CHESS_DIST"; else
  echo "Building Chess at $commit"
  (cd "$repo" && npm run build -w @ghostly/mini-chess >"$work/build.log" 2>&1) || { cat "$work/build.log" >&2; die "Chess did not build"; }
  chess_dist="$repo/apps/mini/chess/dist"
fi
[[ -f "$chess_dist/index.html" ]] || die "no $chess_dist/index.html"
if [[ -n "$(git -C "$repo" status --porcelain -- apps/mini/chess 2>/dev/null)" ]]; then
  echo "note: apps/mini/chess has changes that are not committed; the bundle is built from them" >&2
fi

# ---------- Chess, signed by its own publisher key ----------

# The folder a bundle is published from: the manifest's fields (ghostly-app.json) and the built entry, nothing else.
stage() {
  local dir="$1" sources="${2:-}"
  mkdir -p "$dir"
  node -e '
    const fs = require("node:fs");
    const draft = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (process.argv[3]) draft.sources = [process.argv[3]];
    fs.writeFileSync(process.argv[2], JSON.stringify(draft, null, 2) + "\n");
  ' "$repo/apps/mini/chess/ghostly-app.json" "$dir/ghostly-app.json" "$sources"
  cp "$chess_dist/index.html" "$dir/index.html"
  [[ -f "$repo/apps/mini/chess/icon.png" ]] && cp "$repo/apps/mini/chess/icon.png" "$dir/icon.png"
  return 0
}

# A first publish makes the publisher key: the bundle's folder and URL name the key, so it must exist first.
stage "$work/first"
first="$(cli_json app publish "$work/first" --key "$publisher_key" --out "$work/first.ghostlyapp")"
publisher="$(field "$first" publisher)"
rm -f "$work/first.ghostlyapp"

name="$(field "$first" name)"
folder="apps/$name.${publisher:0:16}"
url="https://raw.githubusercontent.com/$STORE_REPO/HEAD/$folder/app.ghostlyapp"
stage "$work/chess" "$url"
mkdir -p "$store/$folder"
published="$(cli_json app publish "$work/chess" --key "$publisher_key" --out "$store/$folder/app.ghostlyapp")"
verified="$(cli_json app verify "$store/$folder/app.ghostlyapp")"
[[ "$(field "$verified" digest)" == "$(field "$published" digest)" ]] || die "the bundle written does not verify as published"

node -e '
  const fs = require("node:fs");
  const [published, url, out] = process.argv.slice(1);
  const b = JSON.parse(published);
  const m = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const listing = {
    ref: b.ref, sequence: b.sequence, digest: b.digest, urls: [url], title: m.title, tagline: m.tagline,
    category: "Games", developer: "Ghostly", submitter: "Ghostly",
    repo: "https://github.com/MiguelMedeiros/ghostly", support: "https://github.com/MiguelMedeiros/ghostly/issues",
  };
  fs.writeFileSync(out, JSON.stringify(listing, null, 2) + "\n");
' "$published" "$url" "$store/$folder/listing.json" "$repo/apps/mini/chess/ghostly-app.json"
chmod 644 "$store/$folder/listing.json" "$store/$folder/app.ghostlyapp"
chmod 755 "$store/$folder"

# ---------- the first index, signed by the store key ----------

node -e '
  const fs = require("node:fs");
  const [storeDir, listingFile, out] = process.argv.slice(1);
  const meta = JSON.parse(fs.readFileSync(`${storeDir}/store.json`, "utf8"));
  const index = {
    ghostlyStore: 1, name: meta.name, ...(meta.description ? { description: meta.description } : {}), kind: meta.kind,
    sequence: 1,
    // Clients refuse an index more than 90 days ahead of their clock: 80 leaves room for a clock that is late.
    expires: Math.floor(Date.now() / 1000) + 80 * 86400,
    apps: [JSON.parse(fs.readFileSync(listingFile, "utf8"))],
    removed: meta.removed ?? [], revoked: meta.revoked ?? [],
  };
  fs.writeFileSync(out, JSON.stringify(index, null, 2) + "\n");
' "$store" "$store/$folder/listing.json" "$work/index.json"
signed="$(cli_json store sign "$work/index.json" --key "$store_key" --out "$store")"
store_public="$(field "$signed" key)"
printf '%s\n' "$store_public" > "$store/STORE_KEY"
chmod 644 "$store/STORE_KEY" "$store/ghostly-store.json" "$store/ghostly-store.sig"
chmod 600 "$store_key" "$publisher_key"

# ---------- the store's own check, as its CI runs it ----------

if [[ "${STORE_SKIP_CHECK:-}" != 1 && -x "$store/scripts/check.sh" ]]; then
  echo "Checking the store as its CI does"
  GHOSTLY="$repo" "$store/scripts/check.sh" >"$work/check.log" 2>&1 || { cat "$work/check.log" >&2; die "the store's check failed: do not push it"; }
fi

expires="$(node -e 'process.stdout.write(new Date(Number(process.argv[1]) * 1000).toISOString().slice(0, 10))' "$(field "$signed" expires)")"
cat <<EOF

Done. Two new keys are in $keys (owner-only). Nothing was pushed.

  Store key         $store_public
                    fingerprint $(field "$signed" fingerprint)
  Chess publisher   $publisher
                    fingerprint $(field "$published" fingerprint)

Back up $keys offline now (an encrypted USB drive, two copies), and keep it off this machine when you are not
signing. A store is its key, and Chess is updated only with its publisher key: neither can be replaced.

Next:
  1. Look at the store, then push it:
       cd "$store"
       git status
       git add STORE_KEY ghostly-store.json ghostly-store.sig $folder
       git commit -m "Sign the store, list Chess"
       git push
  2. Send the store public key above to the coordinator. It goes in DEFAULT_STORE_KEY
     (packages/browser/src/engine/appDefaults.ts), which turns the default store on.
  3. Sign the index again before $expires (docs/APPS.md, "Signing again").
EOF
