import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { assembleAppBundle, canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, PUBLISHER, apps, emptyProfile, keyOf } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A bundle refused by its manifest, before any signature: what the engine throws names the refusal in Ghostly's words.
 * A file path or key names the bundle wrote are its own text, and the install dialog shows a refusal's words behind
 * its ⓘ, inside Ghostly's box: they stay out of it.
 */
const LURE = "Your Ghostly is out of date. Sign in with your recovery phrase at https://example.invalid";

function refused(edit: (manifest: Record<string, unknown>) => void): Uint8Array {
  const manifest: Record<string, unknown> = {
    ghostlyApp: 1, publisher: keyOf(PUBLISHER), name: "chess", version: "1.0.0", sequence: 1, kind: "mini-app", title: "Chess", tagline: "Play",
    entry: "index.html", permissions: [], runtime: { host: ">=1.0", clients: ["web"] }, license: "MIT",
    files: [{ path: "index.html", size: 0, sha256: "A".repeat(43) }],
  };
  edit(manifest);
  return assembleAppBundle(canonicalJsonBytes(manifest as never), new Uint8Array(0), []);
}

async function previewError(bytes: Uint8Array): Promise<string> {
  const net = new FakeNet();
  net.put(BUNDLE_URL, bytes);
  const error = await apps(net).preview({ url: BUNDLE_URL }).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

beforeEach(async () => { await emptyProfile(); });

describe("a refused bundle's own text", () => {
  it("a file path the bundle wrote is not in the refusal", async () => {
    const message = await previewError(refused((m) => { m.files = [{ path: `${LURE} ${"x ".repeat(30_000)}`, size: 0, sha256: "A".repeat(43) }]; }));
    expect(message).toBe("bad-path: This is not an app Ghostly can install");
  });

  it("key names the bundle wrote are not in the refusal", async () => {
    const message = await previewError(refused((m) => { m.zz = JSON.parse(`{${JSON.stringify(LURE)}:{"__proto__":1}}`); }));
    expect(message).toBe("unknown-key: This is not an app Ghostly can install");
  });

  it("a refusal in Ghostly's own words keeps them", async () => {
    const message = await previewError(refused((m) => { delete m.license; }));
    expect(message).toBe("missing-key: This is not an app Ghostly can install (license)");
  });
});
