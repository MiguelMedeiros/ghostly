import { describe, expect, it } from "vitest";
import { findMoney } from "../../lib/money";
import { previewText } from "../../lib/chatList";
import { loadLocale, translatorFor } from "../../locales";
import { decodeMoneroAddress, findMoneroAddress, moneroBase58Decode, xmrToPiconero } from "../../lib/parse/money-monero";
import {
  BC1Q, XMR_INTEGRATED, XMR_MAINNET, XMR_STAGENET, XMR_STAGENET_INTEGRATED, XMR_STAGENET_SUBADDRESS, XMR_SUBADDRESS,
  XMR_TESTNET, XMR_TESTNET_INTEGRATED, corrupt,
} from "./moneyFormatFixtures";

// covers: payments.money.monero-card

describe("Monero addresses: Base58 blocks, Keccak checksum, network byte", () => {
  it.each([
    ["mainnet standard", XMR_MAINNET, "standard", "mainnet", "mainnet"],
    ["mainnet subaddress", XMR_SUBADDRESS, "subaddress", "mainnet", "mainnet"],
    ["mainnet integrated", XMR_INTEGRATED, "integrated", "mainnet", "mainnet"],
    ["stagenet standard", XMR_STAGENET, "standard", "stagenet", "testnet"],
    ["stagenet subaddress", XMR_STAGENET_SUBADDRESS, "subaddress", "stagenet", "testnet"],
    ["stagenet integrated", XMR_STAGENET_INTEGRATED, "integrated", "stagenet", "testnet"],
    ["testnet standard", XMR_TESTNET, "standard", "testnet", "testnet"],
    ["testnet integrated", XMR_TESTNET_INTEGRATED, "integrated", "testnet", "testnet"],
  ])("reads a %s address", (_, address, kind, chain, network) => {
    expect(decodeMoneroAddress(address)).toEqual({ kind, chain, network });
  });

  it("decodes the integrated address's payment ID where Monero put it", () => {
    const bytes = moneroBase58Decode(XMR_INTEGRATED)!;
    expect(Buffer.from(bytes.subarray(65, 73)).toString("hex")).toBe("0123456789abcdef");
  });

  it.each([
    ["a broken checksum (last character)", corrupt(XMR_MAINNET)],
    ["a broken checksum (a key character)", XMR_MAINNET.slice(0, 40) + (XMR_MAINNET[40] === "a" ? "b" : "a") + XMR_MAINNET.slice(41)],
    ["a broken integrated checksum", corrupt(XMR_INTEGRATED)],
    ["a broken stagenet checksum", corrupt(XMR_STAGENET)],
    ["one character short", XMR_MAINNET.slice(0, -1)],
    ["one character long", XMR_MAINNET + "1"],
    ["an integrated address cut to a standard one's length", XMR_INTEGRATED.slice(0, 95)],
    ["a character outside Base58", XMR_MAINNET.slice(0, -1) + "0"],
    ["a Base58 block over 64 bits", "z".repeat(95)],
  ])("refuses %s", (_, address) => {
    expect(decodeMoneroAddress(address)).toBeNull();
  });

  it("reads XMR amounts to the piconero, and nothing else", () => {
    expect(xmrToPiconero("1")).toBe(1_000_000_000_000n);
    expect(xmrToPiconero("0.000000000001")).toBe(1n);
    expect(xmrToPiconero("12.5")).toBe(12_500_000_000_000n);
    for (const bad of ["", "1.", ".5", "1,5", "-1", "1e3", "0.0000000000001", "abc"]) expect(xmrToPiconero(bad)).toBeNull();
  });
});

describe("Monero in a message", () => {
  it("finds a bare address anywhere in the text, with the rest kept", () => {
    expect(findMoneroAddress(`pay me at ${XMR_SUBADDRESS} thanks`)).toEqual({
      request: { address: XMR_SUBADDRESS, kind: "subaddress", chain: "mainnet", network: "mainnet", uri: `monero:${XMR_SUBADDRESS}` },
      rest: "pay me at  thanks",
    });
  });

  it("reads a monero: link's amount, name and description, and leaves other parameters out", () => {
    const text = `monero:${XMR_MAINNET}?tx_amount=0.25&recipient_name=Bob%27s%20shop&tx_description=Rent%20(May)&tx_payment_id=00&foo=bar.`;
    const found = findMoneroAddress(text)!;
    expect(found.request).toEqual({
      address: XMR_MAINNET, kind: "standard", chain: "mainnet", network: "mainnet", amount: 250_000_000_000n,
      recipientName: "Bob's shop", description: "Rent (May)",
      uri: `monero:${XMR_MAINNET}?tx_amount=0.25&recipient_name=Bob%27s%20shop&tx_description=Rent%20%28May%29`,
    });
    // Only the link's own characters: the sentence's full stop is not part of it.
    expect(found.rest).toBe(".");
    // What Desktop's opener takes (apps/desktop/src/commands.rs is_payment_link).
    expect(found.request.uri).toMatch(/^monero:[A-Za-z0-9?=&%.:_-]+$/);
  });

  it("cuts a link's name and description at 140 characters, so the link it hands on stays one Desktop and the extension open", () => {
    // Written raw, each character comes back as 9 in the link: 500 of them alone would be past Desktop's 4,096.
    const long = "家賃".repeat(250), quoted = "(Rent)".repeat(280);
    for (const text of [`monero:${XMR_INTEGRATED}?tx_amount=123456789012345.123456789012&recipient_name=${long}&tx_description=${long}`, `monero:${XMR_MAINNET}?recipient_name=${quoted}&tx_description=${quoted}`]) {
      const request = findMoneroAddress(text)!.request;
      expect([...request.recipientName!]).toHaveLength(140);
      expect([...request.description!]).toHaveLength(140);
      expect(request.uri.length).toBeLessThanOrEqual(4096);
      expect(request.uri).toMatch(/^monero:[A-Za-z0-9?=&%.:_-]{1,4096}$/);
    }
    // A cut never leaves half of a character pair (encodeURIComponent would throw on it).
    const emoji = findMoneroAddress(`monero:${XMR_MAINNET}?tx_description=a${"👻".repeat(200)}`)!.request;
    expect(emoji.description).toBe(`a${"👻".repeat(139)}`);
  });

  it("says a stagenet link is test money", () => {
    expect(findMoneroAddress(`MONERO:${XMR_STAGENET_INTEGRATED}`)?.request).toMatchObject({ chain: "stagenet", network: "testnet", kind: "integrated" });
  });

  it.each([
    ["a bad checksum", `monero:${corrupt(XMR_MAINNET)}`],
    ["an amount it cannot read", `monero:${XMR_MAINNET}?tx_amount=1,5`],
    ["several recipients", `monero:${XMR_MAINNET};${XMR_SUBADDRESS}?tx_amount=1;2`],
  ])("shows no card for a link with %s, nor for an address inside it", (_, text) => {
    expect(findMoneroAddress(text)).toBeNull();
    expect(findMoney(text)).toBeNull();
  });

  it("is not a card for a lookalike, an address glued to other letters, or one inside a web link", () => {
    expect(findMoneroAddress(`see ${corrupt(XMR_MAINNET)}`)).toBeNull();
    expect(findMoneroAddress(`x${XMR_MAINNET}`)).toBeNull();
    expect(findMoneroAddress(`https://xmrchain.net/search?value=${XMR_MAINNET}`)).toBeNull();
  });

  it("is a money card of its own, after the Bitcoin formats, with a chat list line", () => {
    expect(findMoney(`${XMR_INTEGRATED}`)).toMatchObject({ type: "monero", request: { kind: "integrated" } });
    expect(findMoney(`${BC1Q} or ${XMR_MAINNET}`)).toMatchObject({ type: "onchain" });
    expect(previewText(XMR_MAINNET)).toBe("Monero address · Real money");
    expect(previewText(XMR_STAGENET)).toBe("Monero address · Test money");
  });

  it("says a monero: link's amount in the chat list, in XMR as the card writes it", async () => {
    expect(previewText(`monero:${XMR_STAGENET}?tx_amount=1234.5`)).toBe("Monero address · Test money · 1,234.5 XMR");
    expect(previewText(`monero:${XMR_MAINNET}?tx_amount=0.000000000001`)).toBe("Monero address · Real money · 0.000000000001 XMR");
    await loadLocale("pt");
    expect(previewText(`monero:${XMR_STAGENET}?tx_amount=1234.5`, translatorFor("pt"))).toBe("Endereço Monero · Dinheiro de teste · 1.234,5 XMR");
  });
});
