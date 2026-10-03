import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetLinks } from "../../../apps/web/assetlinks";

/**
 * The Android app (apps/android-twa, docs/ANDROID.md) opens app.ghostly.tools without a URL bar only when the site
 * serves /.well-known/assetlinks.json naming the app's package and signing certificate. The web build writes it from
 * the TWA manifest's fingerprints, and nginx serves it as JSON or not at all.
 */
const root = join(import.meta.dirname, "../../..");
const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

describe("assetlinks.json", () => {
  it("is not written while the manifest has no fingerprint (the key is not made yet)", () => {
    expect(assetLinks({ packageId: "tools.ghostly.app", fingerprints: [] })).toBeNull();
    expect(assetLinks({ packageId: "tools.ghostly.app" })).toBeNull();
  });

  it("names the manifest's package and every fingerprint", () => {
    const body = assetLinks({ packageId: "tools.ghostly.app", fingerprints: [{ name: "upload", value: FP }, { name: "play", value: FP.replace(/^AB/, "00") }] });
    expect(JSON.parse(body!)).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "tools.ghostly.app", sha256_cert_fingerprints: [FP, FP.replace(/^AB/, "00")] },
      },
    ]);
  });

  it("stops the build on a placeholder or a malformed fingerprint", () => {
    for (const value of ["REPLACE_ME", FP.toLowerCase(), FP.slice(3), FP.replaceAll(":", "")]) {
      expect(() => assetLinks({ packageId: "tools.ghostly.app", fingerprints: [{ value }] })).toThrow(/SHA-256/);
    }
    expect(() => assetLinks({ packageId: "Ghostly", fingerprints: [] })).toThrow(/package/);
  });

  it("reads the checked-in manifest without error, for the package the APK is built as", () => {
    const manifest = JSON.parse(readFileSync(join(root, "apps/android-twa/twa-manifest.json"), "utf8"));
    expect(manifest.packageId).toBe("tools.ghostly.app");
    expect(manifest.host).toBe("app.ghostly.tools");
    expect(() => assetLinks(manifest)).not.toThrow();
  });

  it("is served by nginx as JSON, and a missing one is a 404, not the app's page", () => {
    const conf = readFileSync(join(root, "apps/web/nginx.conf"), "utf8").replace(/#.*/g, "");
    const block = /location \^~ \/\.well-known\/ \{([^}]*)\}/.exec(conf)?.[1] ?? "";
    expect(block).toMatch(/try_files \$uri =404;/);
    expect(block).toMatch(/default_type application\/json;/);
    expect(block).toMatch(/include \/etc\/nginx\/ghostly-headers\.conf;/);
  });

  it("is in the web image: the Dockerfile copies the manifest the build reads", () => {
    expect(readFileSync(join(root, "apps/web/Dockerfile"), "utf8")).toMatch(/^COPY apps\/android-twa\/twa-manifest\.json apps\/android-twa\/$/m);
  });
});
