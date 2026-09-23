import { decodeTx, identityStatement, newIdentityBinding, type IdentityStatement } from "@ghostly/core";
import { RawWitness } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import type { ExternalToolSigner } from "../src/proofs/contract";
import { bitcoin, type BitcoinEvidence } from "../src/proofs/providers/bitcoin";
import { identityProvider, IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { verifyIdentity } from "../src/proofs/verify";
import core from "../../core/test/fixtures/bitcoin-core-signmessage.json";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { MAINNET, REGTEST, SIGNET, testBitcoinWallet, type TestNet, type TestScript } from "./helpers/bitcoinSign";

// The shared contract, once per signature format and network the provider accepts.
const cases: [string, TestScript, TestNet, "simple" | "full" | "legacy"][] = [
  ["P2WPKH, BIP-322 simple, signet", "p2wpkh", SIGNET, "simple"],
  ["P2TR, BIP-322 simple, regtest", "p2tr", REGTEST, "simple"],
  ["P2SH-P2WPKH, BIP-322 full, signet", "p2sh-p2wpkh", SIGNET, "full"],
  ["P2PKH, BIP-322 full, regtest", "p2pkh", REGTEST, "full"],
  ["P2PKH, legacy signmessage, signet", "p2pkh", SIGNET, "legacy"],
  ["P2WPKH, BIP-322 simple, mainnet", "p2wpkh", MAINNET, "simple"],
];
for (const [name, kind, net, format] of cases) {
  describeIdentityProof(`Bitcoin (${name})`, async () => {
    const mine = testBitcoinWallet(kind, net), other = testBitcoinWallet(kind, net);
    const sign = (w: typeof mine, s: IdentityStatement): BitcoinEvidence =>
      ({ signature: format === "legacy" ? w.signLegacy(s.text) : format === "simple" ? w.signBip322(s.text).simple! : w.signBip322(s.text).full });
    return { provider: bitcoin, subject: mine.address, prove: async s => sign(mine, s), proveAsOther: async s => sign(other, s) };
  });
}

const statementFor = (subject: string) => {
  const { binding } = newIdentityBinding({ provider: "bitcoin", subject, validitySeconds: 90 * 86_400 });
  return identityStatement(binding);
};
const ctx = () => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch: async () => { throw new Error("no network"); } });
const verify = (s: IdentityStatement, evidence: unknown) => verifyIdentity([bitcoin], s, evidence, ctx());
const signer = (id: string) => bitcoin.signers.find(s => s.id === id) as ExternalToolSigner<BitcoinEvidence>;

describe("Bitcoin identity provider", () => {
  it("is registered", () => {
    expect(IDENTITY_PROVIDERS).toContain(bitcoin);
    expect(identityProvider("bitcoin")).toBe(bitcoin);
  });

  it("says what it does not prove, in the picker and next to the address field", () => {
    for (const text of [bitcoin.description, bitcoin.subject.help!]) expect(text).toMatch(/balance/);
    expect(bitcoin.subject.help).toMatch(/past payment/);
    expect(bitcoin.subject.help).toMatch(/pay you/);
  });

  it("normalizes addresses and refuses what it cannot check", () => {
    const n = bitcoin.subject.normalize;
    expect(n("  BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4 ")).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(n("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toBe("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn");
    expect(n("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw")).toBe("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw");
    expect(() => n("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3")).toThrow(/single-key/);
    expect(() => n("not an address")).toThrow(/Bitcoin address/);
    expect(() => n("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toThrow();
  });

  it("labels test-network addresses wherever they are shown short, and in the verified source", async () => {
    expect(bitcoin.subject.short!("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toMatch(/^tb1qw50…jzsx · test network$/);
    expect(bitcoin.subject.short!("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe("bc1qw50…f3t4");
    const w = testBitcoinWallet("p2wpkh", SIGNET);
    const s = statementFor(w.address);
    expect((await verify(s, { signature: w.signBip322(s.text).simple })).source).toBe("BIP-322 simple signature, P2WPKH, test network");
    const legacy = testBitcoinWallet("p2pkh", MAINNET);
    const l = statementFor(legacy.address);
    expect((await verify(l, { signature: legacy.signLegacy(l.text) })).source).toBe("Legacy signmessage signature, P2PKH");
  });

  it("the statement is one ASCII line wallets can sign", () => {
    const s = statementFor(testBitcoinWallet("p2tr", SIGNET).address);
    expect(s.text).toMatch(/^[\x20-\x7e]+$/);
    expect(s.text).toContain(`I control bitcoin:${s.binding.subject} `);
  });

  it("per wallet: steps for the statement and address, or why it cannot sign for this type", () => {
    const segwit = statementFor(testBitcoinWallet("p2wpkh", SIGNET).address);
    const sparrow = signer("sparrow").instructions(segwit);
    expect(sparrow.steps.map(s => s.copy)).toEqual(expect.arrayContaining([segwit.text, segwit.binding.subject]));
    expect(sparrow.steps.some(s => /BIP322 \(Simple\)/.test(s.text))).toBe(true);
    expect(sparrow.steps.some(s => /Restart In/.test(s.text))).toBe(true);
    expect(sparrow.paste?.label).toBe("Signature");
    const core = signer("bitcoin-core").instructions(segwit);
    expect(core.steps[0].text).toMatch(/cannot sign for a native SegWit/);
    expect(core.steps.some(s => s.copy)).toBe(false);
    const legacy = statementFor(testBitcoinWallet("p2pkh", SIGNET).address);
    const cli = signer("bitcoin-core").instructions(legacy).steps.find(s => s.copy?.startsWith("bitcoin-cli"));
    expect(cli?.copy).toBe(`bitcoin-cli signmessage "${legacy.binding.subject}" '${legacy.text}'`);
    for (const g of bitcoin.signers) expect((g as ExternalToolSigner<BitcoinEvidence>).instructions(segwit).steps.at(-1)!.text).toMatch(/does not show a balance/);
  });

  it("parse: accepts what wallets print, says at once when it does not match", async () => {
    const w = testBitcoinWallet("p2wpkh", SIGNET);
    const s = statementFor(w.address);
    const { simple } = w.signBip322(s.text);
    const parse = signer("sparrow").parse;
    // Wrapped over lines and padded with spaces, as a copy from a narrow window gives it.
    expect(await parse(`  ${simple!.slice(0, 50)}\n${simple!.slice(50)}\n`, s)).toEqual({ signature: simple });
    expect(await parse(simple!.slice(3), s)).toEqual({ signature: simple!.slice(3) });
    await expect(async () => parse("", s)).rejects.toThrow(/Paste/);
    await expect(async () => parse("-----BEGIN PGP SIGNATURE-----", s)).rejects.toThrow(/not a Bitcoin message signature/);
    await expect(async () => parse(testBitcoinWallet("p2wpkh", SIGNET).signBip322(s.text).simple!, s)).rejects.toThrow(/does not match/);
    await expect(async () => parse(w.signBip322(statementFor(w.address).text).simple!, s)).rejects.toThrow(/does not match/);
  });

  it("a legacy signature for a SegWit address is refused, pointing to BIP-322", async () => {
    const w = testBitcoinWallet("p2wpkh", SIGNET);
    const s = statementFor(w.address);
    await expect(verify(s, { signature: w.signLegacy(s.text) })).rejects.toThrow(/BIP-322/);
  });

  it("a nested SegWit address needs the full format", async () => {
    const w = testBitcoinWallet("p2sh-p2wpkh", SIGNET);
    const s = statementFor(w.address);
    const witness = decodeTx(Buffer.from(w.signBip322(s.text).full.slice(3), "base64")).inputs[0].witness;
    await expect(verify(s, { signature: `smp${Buffer.from(RawWitness.encode(witness)).toString("base64")}` })).rejects.toThrow(/full format/);
  });

  it("refuses a proof of funds", async () => {
    const w = testBitcoinWallet("p2wpkh", SIGNET);
    await expect(verify(statementFor(w.address), { signature: "pofAAAA" })).rejects.toThrow(/Proof-of-funds/);
  });

  it("accepts a real Bitcoin Core legacy signature only over its own message", async () => {
    // Bitcoin Core signed other messages; the provider checks the exact statement.
    const [v] = core.legacy;
    await expect(verify(statementFor(v.address), { signature: v.signature })).rejects.toThrow(/does not match/);
  });

  it("evidence is strict", () => {
    for (const raw of [{ signature: "smpAA==", x: 1 }, { sig: "smpAA==" }, { signature: 1 }, { signature: "a b" }, { signature: "A".repeat(9000) }])
      expect(() => bitcoin.parseEvidence(raw)).toThrow();
    expect(bitcoin.parseEvidence({ signature: "smpAA==" })).toEqual({ signature: "smpAA==" });
  });
});
