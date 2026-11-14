import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { CashuWallet } from "../src/engine/wallet";
// covers: payments.cashu.mints

const info = vi.hoisted(() => ({ name: undefined as string | undefined, motd: undefined as string | undefined }));
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  Wallet: class {
    constructor(readonly url: string) {}
    async loadMint(): Promise<void> {}
    getMintInfo = () => ({ name: info.name, motd: info.motd, version: "nutshell/0.16", isSupported: () => ({ supported: true, params: [] }) });
    keyChain = { getKeysets: () => [] };
  },
}));

const MINT = "https://mint.example";
const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };

describe("a Cashu mint's own name", () => {
  it("is shown without the characters that hide text or reorder it, on one line, cut, or as the host when empty", async () => {
    info.name = "‮Good​   mint\n⁦";
    info.motd = "  Hello‮ world​  ";
    const wallet = new CashuWallet(() => [MINT], events);
    expect(await wallet.checkMint(MINT)).toEqual({ url: MINT, name: "Good mint" });
    const [mint] = (await wallet.view()).mints;
    expect(mint).toMatchObject({ name: "Good mint", info: { motd: "Hello world" } });

    info.name = "x".repeat(300);
    expect((await new CashuWallet(() => [MINT], events).checkMint(MINT)).name).toBe("x".repeat(80));

    info.name = "​‮ ⁦";
    expect((await new CashuWallet(() => [MINT], events).checkMint(MINT)).name).toBe("mint.example");
  });
});
