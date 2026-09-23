import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import Module, { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import IdentityKey from 'keet-identity-key';

it('the one-line browser Buffer compatibility patch preserves the upstream Keet derivation', async () => {
  const require = createRequire(import.meta.url);
  const path = require.resolve('keet-identity-key/lib/keychain.js');
  const original = readFileSync(path,'utf8').replace('b4a.writeUInt32BE(state.buffer, step, state.start)', 'state.buffer.writeUInt32BE(step, state.start)');
  const upstream = new Module(path) as Module & { _compile(source: string, filename: string): void };
  upstream.require = createRequire(path);
  upstream._compile(original,path);
  const KeyChain = upstream.exports as { from(input:{seed:Uint8Array}): Promise<unknown> };
  const seed = await IdentityKey.deriveSeed(IdentityKey.generateMnemonic());
  const patched = await IdentityKey.from({seed:new Uint8Array(seed)});
  // Actual upstream constructor consumes the unchanged keychain API.
  const Constructor = IdentityKey as unknown as {new(keyChain:unknown):IdentityKey};
  const originalIdentity = new Constructor(await KeyChain.from({seed}));
  try { expect(Array.from(patched.identityPublicKey)).toEqual(Array.from(originalIdentity.identityPublicKey)); }
  finally { patched.keyChain.seed.fill(0);patched.clear();originalIdentity.keyChain.seed.fill(0);originalIdentity.clear();seed.fill(0); }
});

it('the browser WebCrypto fallback matches the SDK sodium-native mnemonic seed', async () => {
  const require = createRequire(import.meta.url);
  const path = require.resolve('bip39-mnemonic');
  const browserModule = new Module(path) as Module & { _compile(source: string, filename: string): void };
  const localRequire = createRequire(path);
  browserModule.require = ((id: string) => id === 'sodium-universal' ? localRequire('sodium-javascript') : localRequire(id)) as typeof browserModule.require;
  browserModule._compile(readFileSync(path, 'utf8'), path);
  const browser = browserModule.exports as { mnemonicToSeed(input: string): Promise<Uint8Array> };
  const mnemonic = IdentityKey.generateMnemonic();
  const nativeSeed = await IdentityKey.deriveSeed(mnemonic);
  const browserSeed = await browser.mnemonicToSeed(mnemonic);
  try { expect(Array.from(browserSeed)).toEqual(Array.from(nativeSeed)); }
  finally { nativeSeed.fill(0); browserSeed.fill(0); }
});


it('the actual browser bundle derives the same identity and exchanges SDK attestations', async () => {
  const require = createRequire(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'ghostly-keet-'));
  try {
    await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true,
      lib: { entry: require.resolve('keet-identity-key'), formats: ['es'], fileName: () => 'sdk.mjs' }, minify: false } });
    const { default: BrowserIdentity } = await import(pathToFileURL(join(dir, 'sdk.mjs')).href) as { default: typeof IdentityKey };
    const phrase = IdentityKey.generateMnemonic();
    const native = await IdentityKey.from({ mnemonic: phrase });
    const browser = await BrowserIdentity.from({ mnemonic: phrase });
    const data = new TextEncoder().encode('disposable browser compatibility proof');
    try {
      expect(Array.from(browser.identityPublicKey)).toEqual(Array.from(native.identityPublicKey));
      const proof = BrowserIdentity.attestData(data, browser.identityKeyPair);
      expect(IdentityKey.verify(Buffer.from(proof), data, { expectedIdentity: native.identityPublicKey })).toBeTruthy();
      const nativeProof = IdentityKey.attestData(data, native.identityKeyPair);
      expect(BrowserIdentity.verify(new Uint8Array(nativeProof), data, { expectedIdentity: browser.identityPublicKey })).toBeTruthy();
    } finally { native.keyChain.seed.fill(0); native.clear(); browser.keyChain.seed.fill(0); browser.clear(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
