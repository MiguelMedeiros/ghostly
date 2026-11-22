import { describe, expect, it, vi } from "vitest";
import { Amount, getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { MAX_PAIRED_MESSAGE_FRAME } from "@ghostly/core";
import { CashuWallet } from "../src/engine/wallet";
import { TEST_MINT, mintNetwork, mintUrlSpelling } from "../src/shared/mints";
// covers: payments.cashu.token-card

/**
 * A contact's token or request names its mint as their app wrote it. A long run of `/` that does not end the URL took
 * the square of that run to trim (`/\/+$/` retried from each `/`): 36,000 of them in a token, which fits in one message,
 * froze the tab for about a second, several times per card (the engine's read, then the card's network on each render).
 */
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

const RUN = 50_000;
const SLASHES = `https://mint.example/${"/".repeat(RUN)}a`;
const proof = { id: "009a1f293253e41e", amount: Amount.from(1), secret: "a-coin", C: `02${"ab".repeat(32)}` } as Proof;

const timed = <T>(read: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = read();
  return { value, ms: performance.now() - start };
};

describe("a mint URL with a long run of / in it", () => {
  it("is spelled in one pass, whatever the run", () => {
    const spelled = timed(() => mintUrlSpelling(SLASHES));
    expect(spelled.value).toBe(SLASHES);
    expect(spelled.ms).toBeLessThan(100);
    const plain = timed(() => mintUrlSpelling(`not a url ${"/".repeat(RUN)} x`));
    expect(plain.ms).toBeLessThan(100);
    expect(timed(() => mintNetwork(SLASHES)).ms).toBeLessThan(100);
  });

  it("in a contact's token is read without freezing the page", async () => {
    const mint = `https://mint.example/${"/".repeat(36_000)}a`;
    const token = getEncodedToken({ mint, unit: "sat", proofs: [proof] });
    // It fits in one message from a contact.
    expect(new TextEncoder().encode(token).length).toBeLessThan(MAX_PAIRED_MESSAGE_FRAME);
    const wallet = new CashuWallet(() => [TEST_MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() });
    await wallet.inspect("cashuB"); // the library loaded before the clock starts
    const start = performance.now();
    const inspection = await wallet.inspect(token);
    expect(performance.now() - start).toBeLessThan(250);
    expect(inspection).toMatchObject({ kind: "token", mint, accepted: false });
  });

  it("keeps the spelling a wallet stores its mints in", () => {
    expect(mintUrlSpelling("HTTPS://Mint.Example:443/Bitcoin//")).toBe("https://mint.example/Bitcoin");
    expect(mintUrlSpelling("https://mint.example/")).toBe("https://mint.example");
    expect(mintUrlSpelling(" mint.example/// ")).toBe("mint.example");
    expect(mintNetwork(`${TEST_MINT}/`)).toBe("testnet");
  });
});
