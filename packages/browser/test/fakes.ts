/**
 * In-memory stand-ins for IndexedDB (`src/shared/idb`) and for the parts of cashu-ts' Wallet that talk to
 * a mint. Tests swap them in with vi.mock and script what the mint answers.
 */
import { vi } from "vitest";

const KEYS: Record<string, string> = { proofs: "secret", payments: "id", quotes: "quote", walletTx: "id", melts: "quote", swaps: "id" };

type Row = Record<string, unknown>;

export const db = new Map<string, Map<string, Row>>();
/** Set to make the next multi-store transaction fail, as a full disk would. */
export const failures = { nextTransact: false };

export function resetDb(): void {
  db.clear();
  prepared.clear();
  failures.nextTransact = false;
}

export function rows<T>(name: string): T[] {
  return [...(db.get(name)?.values() ?? [])].map((row) => structuredClone(row) as T);
}

export function seed(name: string, values: Row[]): void {
  for (const value of values) table(db, name).set(String(value[KEYS[name]]), structuredClone(value));
}

function table(target: Map<string, Map<string, Row>>, name: string): Map<string, Row> {
  let found = target.get(name);
  if (!found) target.set(name, (found = new Map()));
  return found;
}

function objectStore(target: Map<string, Map<string, Row>>, name: string) {
  const t = table(target, name);
  return {
    getAll: () => [...t.values()].map((row) => structuredClone(row)),
    get: (key: string) => (t.has(key) ? structuredClone(t.get(key)) : undefined),
    count: () => t.size,
    put: (value: Row) => void t.set(String(value[KEYS[name]]), structuredClone(value)),
    delete: (key: string) => void t.delete(key),
  };
}

export const idbModule = {
  STORES: { links: "links", messages: "messages", services: "services", settings: "settings", files: "files", ...Object.fromEntries(Object.keys(KEYS).map((k) => [k, k])) },
  wrap: async <T>(value: T) => value,
  store: async (name: string) => objectStore(db, name),
  async transact(names: string[], work: (stores: Record<string, ReturnType<typeof objectStore>>) => void): Promise<void> {
    // Stage on a copy; commit only if everything went through.
    const staged = new Map([...db].map(([name, t]) => [name, new Map(t)]));
    work(Object.fromEntries(names.map((name) => [name, objectStore(staged, name)])));
    if (failures.nextTransact) {
      failures.nextTransact = false;
      throw new Error("QuotaExceededError");
    }
    for (const name of names) db.set(name, table(staged, name));
  },
};

/** What the fake mint does; each test scripts the calls it cares about. */
export const mint = {
  /** Gets the mint's URL first, so a test can make one mint of several misbehave. */
  createMintQuoteBolt11: vi.fn(),
  checkMintQuoteBolt11: vi.fn(),
  mintProofsBolt11: vi.fn(),
  checkMeltQuoteBolt11: vi.fn(),
  /** Gets the mint's URL first, as createMintQuoteBolt11. */
  createMeltQuoteBolt11: vi.fn(),
  send: vi.fn(),
  completeMelt: vi.fn(),
  checkProofsStates: vi.fn(),
  receive: vi.fn(),
  /** NUT-09: the signatures the mint has for the outputs asked about. Unscripted, it has none. */
  restore: vi.fn(),
};

/**
 * The swaps the wallet prepared, by the secrets they spend. The wallet writes a swap down and sends what it saved, so
 * `completeSwap` gets a preview back: this is how it finds what to hand `mint.send` or `mint.receive`.
 */
const prepared = new Map<string, { kind: "send" | "receive"; args: unknown[] }>();
const spends = (inputs: { secret: string }[]) => inputs.map((p) => p.secret).sort().join(",");
const real = () => vi.importActual<typeof import("@cashu/cashu-ts")>("@cashu/cashu-ts");

export class FakeWallet {
  constructor(readonly url: string) {}
  async loadMint(): Promise<void> {}
  checkMintQuoteBolt11 = (...args: unknown[]) => mint.checkMintQuoteBolt11(...args);
  createMintQuoteBolt11 = (...args: unknown[]) => mint.createMintQuoteBolt11(this.url, ...args);
  /** Minting is prepared, written down, then sent: `mint.mintProofsBolt11` answers it, with the amount and the quote's id. */
  async prepareMint(method: string, amount: number, quote: { quote: string }) {
    return { method, amount, payload: { quote: quote.quote, outputs: [] }, outputData: [], keysetId: "009a1f293253e41e", quote };
  }
  completeMint = (preview: { amount: number; quote: { quote: string } }) => mint.mintProofsBolt11(preview.amount, preview.quote.quote);
  checkMeltQuoteBolt11 = (...args: unknown[]) => mint.checkMeltQuoteBolt11(...args);
  createMeltQuoteBolt11 = (...args: unknown[]) => mint.createMeltQuoteBolt11(this.url, ...args);
  /** No coins ever add up by themselves here: every send is a swap, which `mint.send` answers. */
  sendOffline(): never { throw new Error("No exact coins"); }
  async prepareSwapToSend(amount: number, proofs: { secret: string; amount: number }[], config: unknown) {
    const { Amount } = await real();
    prepared.set(spends(proofs), { kind: "send", args: [amount, proofs, config] });
    return { amount: Amount.from(amount), fees: Amount.zero(), keysetId: "009a1f293253e41e", inputs: proofs.map((p) => ({ ...p, amount: Amount.from(p.amount) })), keepOutputs: [], sendOutputs: [] };
  }
  async prepareSwapToReceive(token: string) {
    const { Amount, getDecodedToken } = await real();
    const inputs = getDecodedToken(token, ["009a1f293253e41e"]).proofs;
    prepared.set(spends(inputs), { kind: "receive", args: [token] });
    return { amount: Amount.sum(inputs.map((p) => p.amount)), fees: Amount.zero(), keysetId: "009a1f293253e41e", inputs, keepOutputs: [] };
  }
  async completeSwap(preview: { inputs: { secret: string }[] }) {
    const call = prepared.get(spends(preview.inputs));
    if (!call) throw new Error("This swap was never prepared");
    return call.kind === "send" ? mint.send(...call.args) : { keep: await mint.receive(...call.args), send: [] };
  }
  mint = { restore: async (request: unknown) => (await mint.restore(request)) ?? { outputs: [], signatures: [] }, getKeys: async () => ({ keysets: [] }) };
  completeMelt = (...args: unknown[]) => mint.completeMelt(...args);
  checkProofsStates = (...args: unknown[]) => mint.checkProofsStates(...args);
  async prepareMelt(method: string, quote: unknown, inputs: unknown[]) {
    return { method, inputs, outputData: [], keysetId: "009a1f293253e41e", quote };
  }
  async ensureOperableKeysets(): Promise<void> {}
  createMeltChangeProofs(): unknown[] {
    return [];
  }
}
