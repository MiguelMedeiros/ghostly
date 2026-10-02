import { resolve } from "node:path";
import { build } from "vite";

/**
 * The app's own device signing key module (`packages/browser/src/devices/signingKey.ts`, WISP 06 § Terms) as one
 * script a page can run, so the engines are measured with the code the app ships and not with a copy of it:
 * Chromium and WebKit under Playwright (`web/device-signing-key.spec.ts`) and the Desktop's WKWebView
 * (`desktop-macos/device-signing-key.spec.ts`). It defines `GhostlyDeviceKey` on the page or the worker it runs in.
 */
let bundle: Promise<string> | null = null;

export function deviceKeyBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      root: resolve(import.meta.dirname, "../.."),
      build: {
        write: false,
        minify: false,
        lib: { entry: resolve(import.meta.dirname, "../../packages/browser/src/devices/signingKey.ts"), formats: ["iife"], name: "GhostlyDeviceKey" },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
    const chunk = output.output.find((entry) => entry.type === "chunk");
    if (!chunk?.code) throw new Error("The device key module did not build");
    // `var GhostlyDeviceKey = …` is local when the script runs inside a function (the Desktop's test driver): said to the global too.
    return `${chunk.code}\n;globalThis.GhostlyDeviceKey = GhostlyDeviceKey;`;
  })();
  return bundle;
}

/** What the scripts below answer: bytes as base64url, so they cross from the page as text. */
export interface DeviceKeyAnswer {
  kind: "webcrypto" | "seed";
  publicKey: string;
  message: string;
  signature: string;
}

/**
 * Page scripts, as source, for `page.evaluate` and for the Desktop's driver alike. Each answers a promise.
 * `GhostlyDeviceKey` must be on the page (the bundle above).
 */
export const DEVICE_KEY_SCRIPTS = {
  /** What the run-time check says of this engine. */
  check: `GhostlyDeviceKey.checkNonExtractableEd25519()`,
  /** Makes (or reads) the profile's key and signs a fresh message with it. `forceSeed` asks for the seed form. */
  use: (profile: string, make: boolean, forceSeed = false) => `(async () => {
    const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    const key = ${make} ? await GhostlyDeviceKey.createDeviceSigningKey(${JSON.stringify(profile)}, { forceSeed: ${forceSeed} }) : await GhostlyDeviceKey.loadDeviceSigningKey(${JSON.stringify(profile)});
    if (!key) return null;
    const message = crypto.getRandomValues(new Uint8Array(32));
    const signature = await key.sign(message);
    return { kind: key.kind, publicKey: b64(key.publicKey), message: b64(message), signature: b64(signature) };
  })()`,
  /**
   * What is stored for the profile, looked at past the module: whether the private key is the engine's own object,
   * whether it says it is extractable, and whether export in each format and a wrap are refused.
   */
  stored: (profile: string) => `(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("ghostly-device-keys"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const record = await new Promise((resolve, reject) => { const r = db.transaction("keys").objectStore("keys").get(${JSON.stringify(profile)}); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.close();
    if (!record) return null;
    const key = record.privateKey;
    const answer = { kind: record.kind, hasSeed: typeof record.seed === "string", isCryptoKey: typeof CryptoKey !== "undefined" && key instanceof CryptoKey, extractable: key ? key.extractable : null, exported: [], wrapped: null };
    if (!key) return answer;
    for (const format of ["pkcs8", "jwk", "raw"]) {
      try { await crypto.subtle.exportKey(format, key); answer.exported.push(format); } catch {}
    }
    try {
      const wrapping = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["wrapKey"]);
      await crypto.subtle.wrapKey("pkcs8", key, wrapping, { name: "AES-GCM", iv: new Uint8Array(12) });
      answer.wrapped = true;
    } catch { answer.wrapped = false; }
    return answer;
  })()`,
};
