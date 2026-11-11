type PubkySdk = typeof import("@synonymdev/pubky");

/**
 * `@synonymdev/pubky`, ready to use. The app's builds fetch its wasm beside the chunk, when `pubkyWasmReady` is first
 * called (packages/browser/vite-plugin.ts); the package's own entries (Node, dev, tests) have none and are ready as
 * they load. Every use goes through here, or its classes run before their wasm is there.
 */
export async function loadPubky(): Promise<PubkySdk> {
  const pubky = await import("@synonymdev/pubky");
  if ("pubkyWasmReady" in pubky) await (pubky.pubkyWasmReady as () => Promise<void>)();
  return pubky;
}
