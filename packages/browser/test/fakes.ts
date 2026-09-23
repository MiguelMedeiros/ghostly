/**
 * In-memory stand-ins for IndexedDB (`src/shared/idb`) and for the parts of cashu-ts' Wallet that talk to
 * a mint. Tests swap them in with vi.mock and script what the mint answers.
 */
import { vi } from "vitest";

const KEYS: Record<string, string> = { proofs: "secret", payments: "id", quotes: "quote", walletTx: "id", melts: "quote" };

type Row = Record<string, unknown>;

export const db = new Map<string, Map<string, Row>>();
/** Set to make the next multi-store transaction fail, as a full disk would. */
export const failures = { nextTransact: false };

export function resetDb(): void {
  db.clear();
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
  send: vi.fn(),
  completeMelt: vi.fn(),
  checkProofsStates: vi.fn(),
  receive: vi.fn(),
};

export class FakeWallet {
  constructor(readonly url: string) {}
  async loadMint(): Promise<void> {}
  checkMintQuoteBolt11 = (...args: unknown[]) => mint.checkMintQuoteBolt11(...args);
  createMintQuoteBolt11 = (...args: unknown[]) => mint.createMintQuoteBolt11(this.url, ...args);
  mintProofsBolt11 = (...args: unknown[]) => mint.mintProofsBolt11(...args);
  checkMeltQuoteBolt11 = (...args: unknown[]) => mint.checkMeltQuoteBolt11(...args);
  send = (...args: unknown[]) => mint.send(...args);
  completeMelt = (...args: unknown[]) => mint.completeMelt(...args);
  checkProofsStates = (...args: unknown[]) => mint.checkProofsStates(...args);
  receive = (...args: unknown[]) => mint.receive(...args);
  async prepareMelt(method: string, quote: unknown, inputs: unknown[]) {
    return { method, inputs, outputData: [], keysetId: "009a1f293253e41e", quote };
  }
  async ensureOperableKeysets(): Promise<void> {}
  createMeltChangeProofs(): unknown[] {
    return [];
  }
}
