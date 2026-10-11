import 'fake-indexeddb/auto';
import { beforeEach, expect, test, vi } from 'vitest';
import { STORES, store, transact, wrap } from '../src/shared/idb';
import { intentRepository } from '../src/engine/paymentAdapters/persistence';
import type { SavedIntent } from '../src/engine/paymentAdapters/coordinator';
// covers: wallet.ready, wallet.mode, wallet.ark.create, wallet.ark.backup, wallet.usdt.create, wallet.usdt.backup

// Providers are faked: these tests cover setup and custody rules, never a network.
const funds = new Map<string, number>();
/** Wallets (by phrase) whose server answers a balance only when the test says so. */
const silent = new Map<string, Promise<number>>();
const info = vi.fn(async () => ({ network: 'bitcoin', signerPubkey: `02${'ab'.repeat(32)}` }));
vi.mock('@arkade-os/sdk', async (original) => ({ ...await original<object>(), RestArkProvider: class { getInfo = info; } }));
vi.mock('../src/engine/paymentAdapters/arkade', () => ({
  ARK_NETWORKS: ['bitcoin', 'mutinynet', 'signet', 'regtest'],
  ArkadeAdapter: { connect: vi.fn(async (config: { provider: string }, mnemonic: string) => ({ config, mnemonic, address: async () => `ark1${mnemonic.split(' ')[0]}`, balance: async () => silent.get(mnemonic) ?? funds.get(mnemonic) ?? 0, boardingAddress: async () => 'tb1qfixture', incoming: async () => 0, dispose: vi.fn() })) },
}));
vi.mock('../src/engine/paymentAdapters/backup', async (original) => ({ ...await original<object>(), snapshotArkDatabase: async () => ({ fixture: true }), restoreArkDatabase: async () => {} }));
vi.mock('../src/engine/paymentAdapters/usdt', () => ({
  UsdtAdapter: {
    inspect: vi.fn(async (config: object) => ({ ...config, decimals: 6, codeHash: '0xfixture' })),
    connect: vi.fn(async (config: object, mnemonic: string) => ({ config, mnemonic, address: async () => '0x00000000000000000000000000000000000000aa', balances: async () => ({ balance: '0', gasBalance: String(funds.get(mnemonic) ?? 0) }), dispose: vi.fn() })),
  },
}));
const { ArkWallet, DEFAULT_ARK, RETIRE_READ_MS } = await import('../src/engine/paymentAdapters/arkWallet');
const { UsdtWallet, DEFAULT_USDT } = await import('../src/engine/paymentAdapters/usdtWallet');
const { ArkadeAdapter } = await import('../src/engine/paymentAdapters/arkade');
const { UsdtAdapter } = await import('../src/engine/paymentAdapters/usdt');
const connected = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
const settings = async () => { const s = await store(STORES.settings, 'readonly'); return { keys: await wrap<IDBValidKey[]>(s.getAllKeys()) }; };
const payment = (method: 'arkade' | 'usdt'): SavedIntent => ({ review: { id: crypto.randomUUID(), payee: 'peer', method, network: method === 'arkade' ? 'bitcoin' : 'ethereum', provider: 'https://fixture.invalid', asset: 'BTC', unit: 'sat', address: 'fixture', expiresAt: Date.now() + 60000, createdAt: Date.now(), amount: 10, fee: 0, feeCap: 0, state: 'settled' }, prepared: {} });

beforeEach(async () => {
  funds.clear(); silent.clear(); info.mockClear();
  await transact([STORES.settings, STORES.intents], s => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

test('a Mainnet Ark wallet made in one click works on Bitcoin with no setup, and it reopens by itself', async () => {
  const first = new ArkWallet('mainnet', () => {}); await first.start();
  await first.ensureReady(true);
  expect(first.view).toMatchObject({ configured: true, locked: false, automatic: true, network: 'bitcoin', provider: DEFAULT_ARK.provider, balance: 0 });
  expect(first.view.address).toMatch(/^ark1/);
  const mnemonic = connected(ArkadeAdapter.connect);
  await first.stop();

  const restarted = new ArkWallet('mainnet', () => {}); await restarted.start();
  expect(restarted.view).toMatchObject({ configured: true, locked: true, automatic: true });
  await restarted.ensureReady(true);
  expect(restarted.view.locked).toBe(false);
  expect(connected(ArkadeAdapter.connect)).toBe(mnemonic);
  expect((await restarted.backup()).mnemonic).toBe(mnemonic);
  await restarted.stop();
});

test('an unreachable provider leaves no half-made wallet and a later attempt succeeds', async () => {
  info.mockRejectedValueOnce(new Error('offline'));
  const wallet = new ArkWallet('mainnet', () => {}); await wallet.start();
  await wallet.ensureReady(true);
  expect(wallet.view.configured).toBe(false);
  expect(wallet.view.error).toContain('Connecting to Ark');
  await wallet.ensureReady(true);
  expect(wallet.view).toMatchObject({ configured: true, locked: false });
  await wallet.stop();
});

test('an empty wallet can move to another test network; its seed is archived, never deleted', async () => {
  // Test networks are the Testnet wallet's: it starts on Mutinynet, and may move while empty.
  const wallet = new ArkWallet('testnet', () => {}); await wallet.start();
  info.mockResolvedValueOnce({ network: 'mutinynet', signerPubkey: `02${'ab'.repeat(32)}` });
  await wallet.ensureReady(true);
  expect(wallet.view).toMatchObject({ network: 'mutinynet', locked: false });
  info.mockResolvedValueOnce({ network: 'regtest', signerPubkey: `02${'cd'.repeat(32)}` });
  await wallet.create({ network: 'regtest', provider: 'http://127.0.0.1:43010', explorer: 'http://127.0.0.1:43000/api' });
  expect(wallet.view).toMatchObject({ network: 'regtest', locked: false, automatic: true });
  expect((await settings()).keys.some(k => String(k).startsWith('arkWallet-retired-'))).toBe(true);
  // Mainnet's networks stay out of reach from here, whatever is empty: they are the Mainnet wallet's.
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('this is the Testnet Ark wallet');
  await wallet.stop();
});

/** Under fake timers the fake IndexedDB only moves as the clock does: tick until `work` ends. */
const settled = async <T>(work: Promise<T>): Promise<T> => {
  let over = false;
  const ended = work.finally(() => { over = true; });
  ended.catch(() => {});
  while (!over) await vi.advanceTimersByTimeAsync(1);
  return ended;
};

test('a Testnet wallet whose server stopped answering moves to another test network after 10 s, on its last balance read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const mutinynet = { network: 'mutinynet', signerPubkey: `02${'ab'.repeat(32)}` }, regtest = { network: 'regtest', signerPubkey: `02${'cd'.repeat(32)}` };
    const local = { network: 'regtest', provider: 'http://127.0.0.1:43010', explorer: 'http://127.0.0.1:43000/api' } as const;
    const wallet = new ArkWallet('testnet', () => {}); await wallet.start();
    info.mockResolvedValueOnce(mutinynet);
    await wallet.ensureReady(true);
    const first = connected(ArkadeAdapter.connect);
    // Read as empty, then its server goes quiet: the switch waits 10 s for it, no longer.
    await wallet.refresh();
    silent.set(first, new Promise(() => {}));
    info.mockResolvedValueOnce(regtest);
    const moving = wallet.create(local);
    await vi.advanceTimersByTimeAsync(RETIRE_READ_MS - 1);
    expect(wallet.view.network).toBe('mutinynet');
    await vi.advanceTimersByTimeAsync(1);
    await settled(moving);
    expect(wallet.view).toMatchObject({ network: 'regtest', locked: false });
    expect((await settings()).keys.some(k => String(k).startsWith('arkWallet-retired-'))).toBe(true);

    // A wallet last read with coins stays, quiet server or not.
    const second = connected(ArkadeAdapter.connect);
    funds.set(second, 500); await settled(wallet.refresh());
    silent.set(second, new Promise(() => {}));
    info.mockResolvedValueOnce(mutinynet);
    const refused = expect(wallet.create({ network: 'mutinynet', provider: 'https://mutinynet.arkade.sh', explorer: 'https://mutinynet.com/api' })).rejects.toThrow('will not be replaced');
    await vi.advanceTimersByTimeAsync(RETIRE_READ_MS);
    await settled(refused);
    expect(wallet.view.network).toBe('regtest');
    await wallet.stop();
  } finally { vi.useRealTimers(); }
});

test('a Mainnet wallet waits for its server\'s own word before it is replaced, however long it takes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const wallet = new ArkWallet('mainnet', () => {}); await wallet.start(); await wallet.ensureReady(true);
    let answer!: (sats: number) => void;
    silent.set(connected(ArkadeAdapter.connect), new Promise(resolve => { answer = resolve; }));
    let settled = false;
    const replacing = wallet.create({ ...DEFAULT_ARK }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * RETIRE_READ_MS);
    expect(settled).toBe(false);
    answer(500);
    await expect(replacing).rejects.toThrow('will not be replaced');
    await wallet.stop();
  } finally { vi.useRealTimers(); }
});

test('a wallet holding funds or with payment history is never replaced', async () => {
  const wallet = new ArkWallet('mainnet', () => {}); await wallet.start(); await wallet.ensureReady(true);
  funds.set(connected(ArkadeAdapter.connect), 500);
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('will not be replaced');
  expect(wallet.view.locked).toBe(false);
  funds.clear();
  await intentRepository.put(payment('arkade'));
  await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow('will not be replaced');
  await wallet.stop();
});

test('a backup file needs a chosen password and restores into a wallet that opens by itself', async () => {
  const wallet = new ArkWallet('mainnet', () => {}); await wallet.start(); await wallet.ensureReady(true);
  const mnemonic = connected(ArkadeAdapter.connect);
  await expect(wallet.exportBackup('short')).rejects.toThrow('12 characters');
  const backup = await wallet.exportBackup('a chosen backup password');
  expect(backup).not.toContain(mnemonic);
  await wallet.stop();
  await transact([STORES.settings], s => { s[STORES.settings].clear(); });

  const restored = new ArkWallet('mainnet', () => {}); await restored.start();
  await restored.restoreBackup(backup, 'a chosen backup password');
  await restored.ensureReady(true);
  expect(restored.view).toMatchObject({ locked: false, automatic: true });
  expect(connected(ArkadeAdapter.connect)).toBe(mnemonic);
  await restored.stop();
});

test('a Mainnet USDT wallet made in one click is on Ethereum with no setup, and it reopens by itself', async () => {
  const first = new UsdtWallet('mainnet', () => {}); await first.start();
  await first.ensureReady(true);
  expect(first.view).toMatchObject({ configured: true, locked: false, automatic: true, network: 'ethereum', chainId: 1, provider: DEFAULT_USDT.provider, token: DEFAULT_USDT.token, balance: '0' });
  const mnemonic = connected(UsdtAdapter.connect);
  expect(await first.reveal()).toBe(mnemonic);
  await first.stop();

  const restarted = new UsdtWallet('mainnet', () => {}); await restarted.start(); await restarted.ensureReady(true);
  expect(restarted.view.locked).toBe(false);
  expect(connected(UsdtAdapter.connect)).toBe(mnemonic);
  funds.set(mnemonic, 1);
  await expect(restarted.create({ ...DEFAULT_USDT })).rejects.toThrow('will not be replaced');
  await restarted.stop();
});

test('a wallet made with a password keeps asking for it', async () => {
  const wallet = new UsdtWallet('mainnet', () => {}); await wallet.start();
  await wallet.create({ ...DEFAULT_USDT, password: 'an older password wallet' });
  await wallet.stop();
  const reopened = new UsdtWallet('mainnet', () => {}); await reopened.start(); await reopened.ensureReady(true);
  expect(reopened.view).toMatchObject({ locked: true, automatic: false });
  await expect(reopened.unlock()).rejects.toThrow('password');
  await reopened.unlock('an older password wallet');
  expect(reopened.view.locked).toBe(false);
  await reopened.stop();
});
