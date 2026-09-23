#!/bin/sh
# Run against a fresh, disposable clone at the documented base commit.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RING_CHECKOUT=${1:?Usage: apply-local.sh /absolute/path/to/disposable/pubky-ring}
EXPECTED=f142436883b4f41a599da37993a9635225f008fa
[ "$(git -C "$RING_CHECKOUT" rev-parse HEAD)" = "$EXPECTED" ] || { echo 'Wrong Ring base revision' >&2; exit 1; }
git -C "$RING_CHECKOUT" apply --check "$ROOT/integrations/pubky-ring/ring.patch"
git -C "$RING_CHECKOUT" apply "$ROOT/integrations/pubky-ring/ring.patch"
mkdir -p "$RING_CHECKOUT/src/ghostly"
cp "$ROOT/integrations/pubky-ring/GhostlyApproval.tsx" "$RING_CHECKOUT/src/ghostly/GhostlyApproval.tsx"
cp "$ROOT/packages/core/src/pubkyRing.ts" "$ROOT/packages/core/src/bytes.ts" "$ROOT/packages/core/src/ringLink.ts" "$ROOT/packages/core/src/ringInput.ts" "$RING_CHECKOUT/src/ghostly/"
echo 'Local Ring extension applied. Install Yarn dependencies and CocoaPods, then build the isolated simulator app.'
