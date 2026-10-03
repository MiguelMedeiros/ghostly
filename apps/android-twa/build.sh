#!/usr/bin/env bash
# Builds the Android app: app.ghostly.tools in a Trusted Web Activity (docs/ANDROID.md).
#
#   apps/android-twa/build.sh            debug APK, signed with the Android debug key (install it to try the app)
#   apps/android-twa/build.sh release    release APK, signed with the upload key from the environment:
#                                        ANDROID_KEYSTORE (a file path), ANDROID_KEYSTORE_PASSWORD,
#                                        ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
#
# Needs Node, JDK 17 (JAVA_HOME) and the Android SDK (ANDROID_HOME) with platforms;android-36 and build-tools 36.0.0.
# The APK lands in apps/android-twa/build/ (or ANDROID_TWA_OUT). Nothing is signed with a key from the repository:
# there is none in it.
set -euo pipefail

MODE="${1:-debug}"
case "$MODE" in debug | release) ;; *) echo "usage: $0 [debug|release]" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${ANDROID_TWA_OUT:-$HERE/build}"
PROJECT="$OUT/project"
BUBBLEWRAP_VERSION="1.25.0"
BUILD_TOOLS_VERSION="36.0.0"

: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 17}"
BUILD_TOOLS="$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION"
[ -x "$BUILD_TOOLS/apksigner" ] || { echo "No build-tools $BUILD_TOOLS_VERSION in $ANDROID_HOME" >&2; exit 1; }

if [ "$MODE" = release ]; then
  : "${ANDROID_KEYSTORE:?Set ANDROID_KEYSTORE to the upload keystore file}"
  : "${ANDROID_KEYSTORE_PASSWORD:?Set ANDROID_KEYSTORE_PASSWORD}"
  : "${ANDROID_KEY_ALIAS:?Set ANDROID_KEY_ALIAS}"
  : "${ANDROID_KEY_PASSWORD:?Set ANDROID_KEY_PASSWORD}"
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"

rm -rf "$OUT"
mkdir -p "$PROJECT"

# The icons and the web manifest Bubblewrap reads come from this checkout (apps/web/public), served on a loopback
# port for the length of the build, not from the live site: the APK matches the commit it is built from.
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/apps/web/public" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$PORT/manifest.json" >/dev/null && break
  sleep 0.1
done

# The manifest Bubblewrap builds from: the checked-in one, with this release's version and the local file URLs.
# versionCode is major*1000000 + minor*1000 + patch, so every release installs over the one before.
node - "$HERE/twa-manifest.json" "$OUT/twa-manifest.json" "$VERSION" "http://127.0.0.1:$PORT" <<'EOF'
const fs = require("fs");
const [source, target, version, local] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(source, "utf8"));
const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0 && n < 1000)) throw new Error(`Version ${version} is not x.y.z`);
m.appVersionName = version;
m.appVersionCode = major * 1000000 + minor * 1000 + patch;
const site = `https://${m.host}`;
const toLocal = (url) => (url && url.startsWith(site + "/") ? local + url.slice(site.length) : url);
m.webManifestUrl = toLocal(m.webManifestUrl);
m.iconUrl = toLocal(m.iconUrl);
m.maskableIconUrl = toLocal(m.maskableIconUrl);
for (const s of m.shortcuts ?? []) s.chosenIconUrl = toLocal(s.chosenIconUrl);
fs.writeFileSync(target, JSON.stringify(m, null, 2) + "\n");
console.log(`Ghostly ${m.appVersionName} (versionCode ${m.appVersionCode}), package ${m.packageId}`);
EOF

# Bubblewrap asks where the JDK and the SDK are unless its config says so: a config of our own, never ~/.bubblewrap.
printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$JAVA_HOME" "$ANDROID_HOME" >"$OUT/bubblewrap-config.json"
npx --yes "@bubblewrap/cli@$BUBBLEWRAP_VERSION" update --skipVersionUpgrade \
  --config="$OUT/bubblewrap-config.json" --manifest="$OUT/twa-manifest.json" --directory="$PROJECT"
kill "$SERVER_PID" 2>/dev/null || true

# The app keeps the web manifest's address (ChromeOS opens the site from it): the real one, not the loopback copy.
SITE="https://$(node -p "require('$HERE/twa-manifest.json').host")"
grep -rlI --exclude-dir=build "127.0.0.1:$PORT" "$PROJECT" | while read -r file; do
  node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(a).join(b))' \
    "$file" "http://127.0.0.1:$PORT" "$SITE"
done
if grep -rlI "127.0.0.1:$PORT" "$PROJECT"; then echo "The project still names the loopback server" >&2; exit 1; fi

# The launcher icon the desktop app's Android build has (an adaptive icon), instead of one cut from the web icon.
RES="$PROJECT/app/src/main/res"
for dir in "$ROOT"/apps/desktop/icons/android/mipmap-*; do
  mkdir -p "$RES/$(basename "$dir")"
  cp "$dir"/* "$RES/$(basename "$dir")/"
done
cp "$ROOT/apps/desktop/icons/android/values/ic_launcher_background.xml" "$RES/values/"

cd "$PROJECT"
chmod +x gradlew
if [ "$MODE" = debug ]; then
  ./gradlew --no-daemon assembleDebug
  APK="$OUT/ghostly-$VERSION-android-debug.apk"
  cp app/build/outputs/apk/debug/app-debug.apk "$APK"
else
  ./gradlew --no-daemon assembleRelease
  APK="$OUT/ghostly-$VERSION-android.apk"
  "$BUILD_TOOLS/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk "$OUT/aligned.apk"
  "$BUILD_TOOLS/apksigner" sign --ks "$ANDROID_KEYSTORE" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
    --ks-key-alias "$ANDROID_KEY_ALIAS" --key-pass env:ANDROID_KEY_PASSWORD --out "$APK" "$OUT/aligned.apk"
  rm -f "$OUT/aligned.apk"
fi
"$BUILD_TOOLS/apksigner" verify --print-certs "$APK" | grep -i "SHA-256 digest" || true
ls -l "$APK"
echo "APK=$APK"
