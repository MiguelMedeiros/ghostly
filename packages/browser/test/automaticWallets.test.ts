import 'fake-indexeddb/auto';
import { beforeEach, expect, test, vi } from 'vitest';
import { STORES, store, transact, wrap } from '../src/shared/idb';
import { intentRepository } from '../src/engine/paymentAdapters/persistence';
import type { SavedIntent } from '../src/engine/paymentAdapters/coordinator';
// covers: wallet.ready, wallet.mode, wallet.ark.create, wallet.ark.backup, wallet.usdt.create, wallet.usdt.backup

// Providers are faked: these tests cover setup and custody rules, never a network.
const funds = new Map<string, number>();
const info = vi.fn(async () => ({ network: 'bitcoin', signerPubkey: `02${'ab'.repeat(32)}` }));
vi.mock('@arkade-os/sdk', async (original) => ({ ...await original<object>(), RestArkProvider: class { getInfo = info; } }));
vi.mock('../src/engine/paymentAdapters/arkade', () => ({
  ARK_NETWORKS: ['bitcoin', 'mutinynet', 'signet', 'regtest'],
  ArkadeAdapter: { connect: vi.fn(async (config: { provider: string }, mnemonic: string) => ({ config, mnemonic, address: async () => `ark1${mnemonic.split(' ')[0]}`, balance: async () => funds.get(mnemonic) ?? 0, boardingAddress: async () => 'tb1qfixture', incoming: async () => 0, dispose: vi.fn() })) },
}));
vi.mock('../src/engine/paymentAdapters/backup', async (original) => ({ ...await original<object>(), snapshotArkDatabase: async () => ({ fixture: true }), restoreArkDatabase: async () => {} }));
vi.mock('../src/engine/paymentAdapters/usdt', () => ({
  UsdtAdapter: {
    inspect: vi.fn(async (config: object) => ({ ...config, decimals: 6, codeHash: '0xfixture' })),
    connect: vi.fn(async (config: object, mnemonic: string) => ({ config, mnemonic, address: async () => '0x00000000000000000000000000000000000000aa', balances: async () => ({ balance: '0', gasBalance: String(funds.get(mnemonic) ?? 0) }), dispose: vi.fn() })),
  },
}));
const { ArkWallet, DEFAULT_ARK } = await import('../src/engine/paymentAdapters/arkWallet');
const { UsdtWallet, DEFAULT_USDT } = await import('../src/engine/paymentAdapters/usdtWallet');
const { ArkadeAdapter } = await import('../src/engine/paymentAdapters/arkade');
const { UsdtAdapter } = await import('../src/engine/paymentAdapters/usdt');
const connected = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
const settings = async () => { const s = await store(STORES.settings, 'readonly'); return { keys: await wrap<IDBValidKey[]>(s.getAllKeys()) }; };
const payment = (method: 'arkade' | 'usdt'): SavedIntent => ({ review: { id: crypto.randomUUID(), payee: 'peer', method, network: method === 'arkade' ? 'bitcoin' : 'ethereum', provider: 'https://fixture.invalid', asset: 'BTC', unit: 'sat', address: 'fixture', expiresAt: Date.now() + 60000, createdAt: Date.now(), amount: 10, fee: 0, feeCap: 0, state: 'settled' }, prepared: {} });

beforeEach(async () => {
  funds.clear(); info.mockClear();
  await transact([STORES.settings, STORES.intents], s => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

test('a new profile gets a working Ark wallet on Bitcoin without any setup, and it reopens by itself', async () => {
  const first = new ArkWallet(() => {}); await first.start();
  await first.ensureReady();
  expect(first.view).toMatchObject({ configured: true, locked: false, automatic: true, network: 'bitcoin', provider: DEFAULT_ARK.provider, balance: 0 });
  expect(first.view.address).toMatch(/^ark1/);
  const mnemonic = connected(ArkadeAdapter.connect);
  await first.stop();

  const restarted = new ArkWallet(() => {}); await restarted.start();
  expect(restarted.view).toMatchObject({ configured: true, locked: true, automatic: true });
  await restarted.ensureReady();
  expect(restarted.view.locked).toBe(false);
  expect(connected(ArkadeAdapter.connect)).toBe(mnemonic);
  expect((await restarted.backup()).mnemonic).toBe(mnemonic);
  await restarted.stop();
});

test('an unreachable provider leaves no half-made wallet and a later attempt succeeds', async () => {
  info.mockRejectedValueOnce(new Error('offline'));
  const wallet = new ArkWallet(() => {}); await wallet.start();
  await wallet.ensureReady();
  expect(wallet.view.configured).toBe(false);
  expect(wallet.view.error).toContain('Connecting to Ark');
  await wallet.ensureReady();
  expect(wallet.view).toMatchObject({ configured: true, locked: false });
  await wallet.stop();
});

test('an empty wallet can move to another test network; its seed is archived, never deleted', async () => {
  // Test networks are the Testnet mode's: there the wallet starts on Mutinynet, and may move while empty.
  const wallet = new ArkWallet(() => {}); await wallet.start(); await wallet.setMode('testnet');
  info.mockResolvedValueOnce({ network: 'mutinynet', signerPubkey: `02${'ab'.repeat(32)}` });
  await wallet.ensureReady();
  expect(wallet.view).toMatchObject({ network: 'mutinynet', locked: false });
  info.mockResolvedValueOnce({ network: 'regtest', signerPubkey: `02${'cd'.repeat(32)}` });
  await wallet.create({ network: 'regtest', provider: 'http://127.0.0.1:43010', explorer: 'http://127.0.0.1:43000/api' });
  expect(wallet.view).toMatchObject({ network: 'regtest', locked: false, automatic: true });
  expect((await settings()).keys.some(k => String(k).startsWith('arkWallet-retired-'))).toBe(true);
  // Mainnet's networks stay out of reach from here, whatever is empty.
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('Switch the wallets to Mainnet');
  await wallet.stop();
});

test('a wallet holding funds or with payment history is never replaced', async () => {
  const wallet = new ArkWallet(() => {}); await wallet.start(); await wallet.ensureReady();
  funds.set(connected(ArkadeAdapter.connect), 500);
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('will not be replaced');
  expect(wallet.view.locked).toBe(false);
  funds.clear();
  await intentRepository.put(payment('arkade'));
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('will not be replaced');
  await wallet.stop();
});

test('a backup file needs a chosen password and restores into a wallet that opens by itself', async () => {
  const wallet = new ArkWallet(() => {}); await wallet.start(); await wallet.ensureReady();
  const mnemonic = connected(ArkadeAdapter.connect);
  await expect(wallet.exportBackup('short')).rejects.toThrow('12 characters');
  const backup = await wallet.exportBackup('a chosen backup password');
  expect(backup).not.toContain(mnemonic);
  await wallet.stop();
  await transact([STORES.settings], s => { s[STORES.settings].clear(); });

  const restored = new ArkWallet(() => {}); await restored.start();
  await restored.restoreBackup(backup, 'a chosen backup password');
  await restored.ensureReady();
  expect(restored.view).toMatchObject({ locked: false, automatic: true });
  expect(connected(ArkadeAdapter.connect)).toBe(mnemonic);
  await restored.stop();
});

test('a new profile gets a USDT wallet on Ethereum without any setup, and it reopens by itself', async () => {
  const first = new UsdtWallet(() => {}); await first.start();
  await first.ensureReady();
  expect(first.view).toMatchObject({ configured: true, locked: false, automatic: true, network: 'ethereum', chainId: 1, provider: DEFAULT_USDT.provider, token: DEFAULT_USDT.token, balance: '0' });
  const mnemonic = connected(UsdtAdapter.connect);
  expect(await first.reveal()).toBe(mnemonic);
  await first.stop();

  const restarted = new UsdtWallet(() => {}); await restarted.start(); await restarted.ensureReady();
  expect(restarted.view.locked).toBe(false);
  expect(connected(UsdtAdapter.connect)).toBe(mnemonic);
  funds.set(mnemonic, 1);
  await expect(restarted.create({ ...DEFAULT_USDT })).rejects.toThrow('will not be replaced');
  await restarted.stop();
});

test('a wallet made with a password keeps asking for it', async () => {
  const wallet = new UsdtWallet(() => {}); await wallet.start();
  await wallet.create({ ...DEFAULT_USDT, password: 'an older password wallet' });
  await wallet.stop();
  const reopened = new UsdtWallet(() => {}); await reopened.start(); await reopened.ensureReady();
  expect(reopened.view).toMatchObject({ locked: true, automatic: false });
  await expect(reopened.unlock()).rejects.toThrow('password');
  await reopened.unlock('an older password wallet');
  expect(reopened.view.locked).toBe(false);
  await reopened.stop();
});
