import { describe, expect, it } from "vitest";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT } from "@ghostly/core";
import { findMoney } from "../../lib/money";
import { previewText } from "../../lib/chatList";
import { addressChain, btcToSats, chainAccepts, findBitcoinAddress } from "../../lib/parse/money-bitcoin";
import { decodeBolt12Offer } from "../../lib/parse/money-bolt12";
import { decodeArkAddress } from "../../lib/parse/money-ark";
import { eip681Number, findUsdtAddress, isEvmAddress } from "../../lib/parse/money-usdt";
import {
  BARK_MAINNET, BARK_TESTNET, BC1P, BC1Q, BOLT12_SPEC_MINIMAL, EVM, EVM_BAD_CASE, P2PKH, P2SH, TB1Q, TEST_P2PKH,
  arkadeAddress, bcrt1q, bolt12Offer, corrupt,
} from "./moneyFormatFixtures";

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.money.ark-card, payments.money.usdt-card, payments.money.network

// A real regtest bolt11 is not needed: the Lightning parser has its own tests. This one is mainnet 21u.
const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";

describe("Bitcoin addresses: checksums and networks", () => {
  it.each([
    ["P2WPKH", BC1Q, "bitcoin"],
    ["P2TR (bech32m)", BC1P, "bitcoin"],
    ["upper-case bech32", BC1Q.toUpperCase(), "bitcoin"],
    ["testnet P2WPKH", TB1Q, "testnet"],
    ["regtest P2WPKH", bcrt1q(), "regtest"],
    ["P2PKH", P2PKH, "bitcoin"],
    ["P2SH", P2SH, "bitcoin"],
    ["testnet P2PKH", TEST_P2PKH, "testnet"],
  ])("reads a %s address's chain from its prefix", (_, address, chain) => {
    expect(addressChain(address)).toBe(chain);
  });

  it.each([
    ["a broken bech32 checksum", corrupt(BC1Q)],
    ["a broken base58 checksum", corrupt(P2PKH)],
    ["mixed case", "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
    ["bech32m on a version 0 program", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh"],
    ["a regtest program under a testnet prefix", bcrt1q().replace(/^bcrt/, "tb")],
  ])("refuses %s", (_, address) => {
    expect(addressChain(address)).toBeNull();
  });

  it("says which network: bc/1/3 real money, tb/bcrt/m/n/2 test money", () => {
    expect(findBitcoinAddress(`send to ${BC1Q} please`)).toMatchObject({ request: { address: BC1Q, network: "mainnet", chain: "bitcoin" }, rest: "send to  please" });
    expect(findBitcoinAddress(bcrt1q())?.request).toMatchObject({ network: "testnet", chain: "regtest" });
    expect(findBitcoinAddress(TB1Q)?.request).toMatchObject({ network: "testnet", chain: "testnet" });
    expect(findBitcoinAddress(TEST_P2PKH)?.request).toMatchObject({ network: "testnet" });
  });

  it("knows which test chain can pay which address", () => {
    expect(chainAccepts("regtest", bcrt1q())).toBe(true);
    expect(chainAccepts("signet", TB1Q)).toBe(true);
    expect(chainAccepts("mutinynet", TB1Q)).toBe(true);
    expect(chainAccepts("regtest", TB1Q)).toBe(false);
    expect(chainAccepts("bitcoin", TB1Q)).toBe(false);
  });
});

describe("BIP 21 links", () => {
  it.each([
    ["1", 100_000_000],
    ["0.001", 100_000],
    ["0.00000001", 1],
    [".5", 50_000_000],
    ["20999999.99999999", 2_099_999_999_999_999],
  ])("reads amount=%s as %d sats", (amount, sats) => {
    expect(btcToSats(amount)).toBe(sats);
  });

  it.each(["1e-3", "0.000000001", "-1", "abc", "0", "21000001", "1,5"])("refuses amount=%s", (amount) => {
    expect(btcToSats(amount)).toBeNull();
  });

  it("reads the address, amount, label, message and Lightning fallback", () => {
    const address = bcrt1q();
    const uri = `bitcoin:${address}?amount=0.0002&label=Luke%20Jr&message=Donation+for%20the%20project&lightning=${INVOICE}`;
    // A mainnet invoice is not the same payment as a regtest address: left out.
    expect(findMoney(`here: ${uri}.`)).toEqual({
      type: "onchain",
      request: { address, chain: "regtest", network: "testnet", amountSat: 20_000, label: "Luke Jr", message: "Donation for the project", uri },
      rest: "here: .",
    });
    const mainnet = findMoney(`BITCOIN:${BC1Q.toUpperCase()}?amount=0.00021&lightning=${INVOICE}`);
    expect(mainnet).toMatchObject({ type: "onchain", request: { address: BC1Q.toUpperCase(), network: "mainnet", amountSat: 21_000, lightning: { amountSat: 2100 } } });
  });

  it("keeps a link it cannot fully read from being paid: unknown req- parameters, an unreadable amount", () => {
    expect(findMoney(`bitcoin:${BC1Q}?req-somethingnew=1`)).toMatchObject({ type: "onchain", request: { unsupported: ["req-somethingnew"] } });
    expect(findMoney(`bitcoin:${BC1Q}?amount=1e3`)).toMatchObject({ type: "onchain", request: { unsupported: ["amount"] } });
    // An optional parameter it does not know is fine.
    expect(findMoney(`bitcoin:${BC1Q}?somethingnew=1`)).toMatchObject({ type: "onchain", request: { address: BC1Q } });
    expect((findMoney(`bitcoin:${BC1Q}?somethingnew=1`) as { request: { unsupported?: string[] } }).request.unsupported).toBeUndefined();
  });

  it("reads a link with no address as what it carries: an invoice, an offer, an Ark address", () => {
    expect(findMoney(`bitcoin:?lightning=${INVOICE}`)).toMatchObject({ type: "lightning", invoice: { amountSat: 2100 }, rest: "" });
    expect(findMoney(`bitcoin:?lno=${BOLT12_SPEC_MINIMAL}`)).toMatchObject({ type: "bolt12", rest: "" });
    const ark = arkadeAddress("tark");
    expect(findMoney(`pay bitcoin:?ark=${ark}&amount=0.00005`)).toMatchObject({ type: "ark", request: { address: ark, kind: "arkade", network: "testnet", amountSat: 5000 }, rest: "pay" });
  });

  it("is not fooled by a link with a bad address", () => {
    expect(findMoney(`bitcoin:${corrupt(BC1Q)}?amount=1 and some words to make it long`)).toBeNull();
  });
});

describe("BOLT 12 offers", () => {
  it("decodes BOLT 12's own minimal vector: Bitcoin, no amount", () => {
    expect(decodeBolt12Offer(BOLT12_SPEC_MINIMAL)).toMatchObject({ network: "mainnet", chain: "bitcoin", description: "Test vectors" });
  });

  it("reads the network from offer_chains, and the amount, description and issuer", () => {
    expect(decodeBolt12Offer(bolt12Offer({ chains: ["regtest"], amountMsat: 21_000_000, description: "Coffee", issuer: "Café" }))).toMatchObject({
      network: "testnet", chain: "regtest", amountSat: 21_000, description: "Coffee", issuer: "Café",
    });
    expect(decodeBolt12Offer(bolt12Offer({ chains: ["signet"] }))).toMatchObject({ network: "testnet", chain: "signet" });
    // An offer for Bitcoin and a test chain is read as real money.
    expect(decodeBolt12Offer(bolt12Offer({ chains: ["regtest", "bitcoin"] }))).toMatchObject({ network: "mainnet" });
    expect(decodeBolt12Offer(bolt12Offer({ currency: "USD", amountMsat: 500 }))).toMatchObject({ currency: "USD", currencyAmount: 500n });
  });

  it("accepts an offer split with + and whitespace, in upper case", () => {
    const offer = bolt12Offer({ description: "split" });
    const split = `${offer.slice(0, 30)}+\n  ${offer.slice(30)}`;
    expect(decodeBolt12Offer(split)?.offer).toBe(offer);
    expect(decodeBolt12Offer(offer.toUpperCase())?.offer).toBe(offer);
  });

  it.each([
    ["no issuer key or path", "lno1pgx9getnwss8vetrw3hhyuck"],
    ["mixed case", BOLT12_SPEC_MINIMAL.slice(0, 20) + BOLT12_SPEC_MINIMAL.slice(20).toUpperCase()],
    ["a cut-off stream", BOLT12_SPEC_MINIMAL.slice(0, -10)],
    ["a word that is not bech32", "lno1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  ])("refuses %s", (_, text) => {
    expect(decodeBolt12Offer(text)).toBeNull();
  });

  it("finds an offer in a message, bare or with lightning:", () => {
    const offer = bolt12Offer({ chains: ["regtest"], description: "tip jar" });
    expect(findMoney(`my tip jar: lightning:${offer} thanks`)).toMatchObject({ type: "bolt12", offer: { offer, network: "testnet" }, rest: "my tip jar:  thanks" });
  });
});

describe("Ark addresses", () => {
  it("tells Arkade (version 0) from Bark (version 1), and the network from the prefix", () => {
    expect(decodeArkAddress(arkadeAddress("tark"))).toEqual({ kind: "arkade", network: "testnet" });
    expect(decodeArkAddress(arkadeAddress("ark"))).toEqual({ kind: "arkade", network: "mainnet" });
    expect(decodeArkAddress(BARK_TESTNET)).toEqual({ kind: "bark", network: "testnet" });
    expect(decodeArkAddress(BARK_MAINNET)).toEqual({ kind: "bark", network: "mainnet" });
  });

  it.each([
    ["a broken checksum", corrupt(BARK_TESTNET)],
    ["another prefix", arkadeAddress("tark").replace(/^tark/, "bark")],
    ["a truncated Arkade payload", "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94"],
  ])("refuses %s", (_, text) => {
    expect(decodeArkAddress(text)).toBeNull();
  });

  it("finds one in a message", () => {
    expect(findMoney(`my ark: ${BARK_TESTNET}`)).toMatchObject({ type: "ark", request: { address: BARK_TESTNET, kind: "bark", network: "testnet" }, rest: "my ark:" });
  });
});

describe("USDT addresses", () => {
  it("checks EIP-55 on mixed-case addresses only", () => {
    expect(isEvmAddress(EVM)).toBe(true);
    expect(isEvmAddress(EVM.toLowerCase())).toBe(true);
    expect(isEvmAddress(EVM_BAD_CASE)).toBe(false);
    expect(isEvmAddress(ETHEREUM_USDT)).toBe(true);
  });

  it.each([["1500000", 1_500_000n], ["1.5e6", 1_500_000n], ["2e0", 2n], ["1.25e1", null], ["-1", null]])("reads the EIP-681 number %s", (text, value) => {
    expect(eip681Number(text)).toBe(value);
  });

  it("reads a transfer link: the token, the chain (network), the recipient and the amount", () => {
    const uri = `ethereum:${ETHEREUM_USDT}@1/transfer?address=${EVM}&uint256=2.5e6`;
    expect(findMoney(`pay me ${uri}`)).toEqual({ type: "usdt", request: { recipient: EVM, chainId: 1, network: "mainnet", token: ETHEREUM_USDT.toLowerCase(), amount: 2_500_000n, uri }, rest: "pay me" });
    expect(findUsdtAddress(`ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${EVM}`)?.request).toMatchObject({ network: "testnet", chainId: 11155111 });
  });

  it("is conservative: a bare 0x address needs USDT named, and then says no network", () => {
    expect(findMoney(`my USDT address is ${EVM}`)).toEqual({ type: "usdt", request: { recipient: EVM }, rest: "my USDT address is" });
    expect(findMoney(`the contract is at ${EVM}, have a look at it please`)).toBeNull();
    // A transfer of a token that is not a known USDT, with nothing saying USDT: not a USDT card.
    expect(findMoney(`ethereum:${EVM}@1/transfer?address=${EVM}&uint256=1`)).toBeNull();
    // An unknown chain: shown without a network, never paid.
    expect(findUsdtAddress(`usdt ethereum:${EVM}@137`)?.request).toEqual({ recipient: EVM, chainId: 137, uri: `ethereum:${EVM}@137` });
    // A bad checksum is nobody's address.
    expect(findMoney(`my USDT address is ${EVM_BAD_CASE}`)).toBeNull();
  });
});

describe("false positives: ordinary text stays text", () => {
  it.each([
    "hello there, how are you doing today my friend?",
    "the tx id is 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 is the empty hash",
    "my git commit 1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5 fixed it",
    "abc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 is not an address",
    "a word like bc1 or tb1 alone is nothing, nor is bcrt1q",
    "Base58-ish 1111111111111111111114oLvT2 with a burn-address checksum is fine",
    "lno1 is a prefix, lno1abc is not an offer, and lnotes are notes",
    "tark1 and ark1 alone mean nothing: ark1qqqqqqqq",
    "0x0000000000000000000000000000000000000000 is the zero address, no USDT here",
    "call me at +1 555 123 4567 or mail someone@example.com today",
    "https://example.com/bitcoin/path?amount=1 is a web page",
    `see https://mempool.space/address/${BC1Q} for the history`,
    `explorer: https://etherscan.io/address/${EVM} (USDT)`,
    `https://arkade.example/${BARK_TESTNET}`,
    "bitcoin: the currency, not a link",
    "ethereum:not-an-address@1 and usdt",
  ])("%s", (text) => {
    const money = findMoney(text);
    // The burn address is a valid base58check mainnet address: the only one here that counts.
    if (text.startsWith("Base58-ish")) expect(money).toMatchObject({ type: "onchain", request: { network: "mainnet" } });
    else expect(money).toBeNull();
  });
});

describe("the chat list's line", () => {
  it("names the format and the network in words", () => {
    expect(previewText(`bitcoin:${bcrt1q()}?amount=0.0001`)).toBe("₿ Bitcoin address · Test money · 10,000 test sats");
    expect(previewText(BC1Q)).toBe("₿ Bitcoin address · Real money");
    expect(previewText(bolt12Offer({ chains: ["regtest"], amountMsat: 5_000_000 }))).toBe("⚡ Lightning offer · Test money · 5,000 test sats");
    expect(previewText(BARK_TESTNET)).toBe("Ark address · Test money");
    expect(previewText(`USDT: ${EVM}`)).toBe("USDT address");
  });
});
