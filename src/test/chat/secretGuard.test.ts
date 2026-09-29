import { describe, expect, it } from "vitest";
import { decodeCashu, findSecret } from "../../lib/parse/secrets";

// covers: app.composer.secret-guard

/**
 * The corpus the composer's secret guard is held to. Every secret here is a published test vector or made of
 * repeated bytes (entropy 0x7f…, key 0x01…): none of them has ever held or will ever hold anything.
 */

/** BIP39's own test vectors for entropy 0x7f repeated (16, 20, 24, 28 and 32 bytes). */
const MNEMONICS = [
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage wise",
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will",
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year viable",
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
];
const ABANDON = `${"abandon ".repeat(11)}about`;
/** Key 0x0101…01. */
const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
const NPUB = "npub1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8j9gdm";
const WIF = { compressed: "KwFfNUhSDaASSAwtG7ssQM1uVX8RgX5GHWnnLfhfiQDigjioWXHH", uncompressed: "5HpjE2Hs7vjU4SN3YyPQCdhzCu92WoEeuE6PWNuiPyTu3ESGnzn", testnet: "cMceqPhHedrhbcR9eXgzmfWy7kRqLyAxMYwFT6ABDWsiwUp9Nsq9" };
/** BIP32 test vector 1, master key. */
const XPRV = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
const XPUB = "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const HEX = "01".repeat(32);

/** A cashuA (NUT-00 v3) token: base64url JSON. */
const cashuA = (amounts: number[], unit?: string) => "cashuA" + btoa(JSON.stringify({
  token: [{ mint: "http://mint.test", proofs: amounts.map((amount, i) => ({ id: "009a1f293253e41e", amount, secret: `test-secret-${i}`, C: "02" + "11".repeat(32) })) }],
  ...(unit ? { unit } : {}),
})).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A cashuB (v4, CBOR) token for 8 + 13 sat on http://mint.test, as @cashu/cashu-ts 4.10 encodes it. */
const CASHU_B_21 = "cashuBo2FtcGh0dHA6Ly9taW50LnRlc3RhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIKjYWEIYXNtdGVzdC1zZWNyZXQtYWFjWCECERERERERERERERERERERERERERERERERERERERERERGjYWENYXNtdGVzdC1zZWNyZXQtYmFjWCECIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";

const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
const INVITE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";

describe("what the guard asks about", () => {
  it.each(MNEMONICS.map((m) => [m.split(" ").length, m]))("a %i-word BIP39 seed", (_, mnemonic) => {
    expect(findSecret(mnemonic)).toEqual({ kind: "mnemonic" });
  });

  it.each([
    ["with a label before it", `my seed: ${ABANDON}`],
    ["and text after it", `${MNEMONICS[1]}\nkeep this safe please`],
    ["in capitals", ABANDON.toUpperCase()],
    ["one word per line", MNEMONICS[0].split(" ").join("\n")],
    ["as a numbered list", MNEMONICS[2].split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n")],
    ["separated by commas", MNEMONICS[0].split(" ").join(", ")],
    ["inside a longer run of seed words", `zoo zoo ${MNEMONICS[0]} zoo`],
  ])("a seed %s", (_, text) => {
    expect(findSecret(text)?.kind).toBe("mnemonic");
  });

  it("a message that is only seed words, even with a mistyped word breaking the checksum", () => {
    const typo = MNEMONICS[0].replace("yellow", "yard");
    expect(findSecret(`${typo} zoo`)).toBeNull(); // checksum fails and the run is not the whole message
    expect(findSecret(typo)).toEqual({ kind: "mnemonic" });
  });

  it.each([
    ["an nsec", NSEC],
    ["an nsec in a sentence", `here is my key ${NSEC} ok`],
    ["an nsec in capitals", NSEC.toUpperCase()],
  ])("%s", (_, text) => expect(findSecret(text)).toEqual({ kind: "nsec" }));

  it.each([
    ["a compressed WIF", WIF.compressed],
    ["an uncompressed WIF", WIF.uncompressed],
    ["a testnet WIF", `import this: ${WIF.testnet}`],
    ["an xprv", XPRV],
    ["a tprv", `tprv${XPRV.slice(4)}`], // the shape is enough: the prefix says what it is
  ])("%s", (_, text) => expect(findSecret(text)).toEqual({ kind: "bitcoin-key" }));

  it.each([
    ["private key: …", `private key: ${HEX}`],
    ["privkey=0x…", `privkey=0x${HEX}`],
    ["… is the secret", `${HEX} is the secret`],
    ["a 128-hex seed", `seed ${"ab".repeat(64)}`],
    ["the Ark wallet's private key", `ark wallet private key\n${HEX}`],
  ])("64-hex next to a word that says what it is: %s", (_, text) => expect(findSecret(text)).toEqual({ kind: "hex-key" }));

  it("a cashuA token, with its amount decoded here", () => {
    expect(findSecret(cashuA([1, 4, 16]))).toEqual({ kind: "cashu", amount: 21, unit: "sat" });
    expect(findSecret(`for you ${cashuA([100], "usd")} thanks`)).toEqual({ kind: "cashu", amount: 100, unit: "usd" });
  });

  it("a cashuB token, with its amount decoded here", () => {
    expect(findSecret(CASHU_B_21)).toEqual({ kind: "cashu", amount: 21, unit: "sat" });
  });

  it("several tokens add up; one that cannot be read leaves the amount unknown", () => {
    expect(findSecret(`${CASHU_B_21} and ${cashuA([4])}`)).toEqual({ kind: "cashu", amount: 25, unit: "sat" });
    expect(findSecret(`${CASHU_B_21} and cashuBnotreallyatokenatallxx`)).toEqual({ kind: "cashu", amount: null, unit: "sat" });
    expect(findSecret(`${CASHU_B_21} ${cashuA([4], "usd")}`)).toEqual({ kind: "cashu", amount: null, unit: "sat" });
  });

  it("a seed next to a token is asked about as the seed", () => {
    expect(findSecret(`${CASHU_B_21}\n${ABANDON}`)).toEqual({ kind: "mnemonic" });
  });

  it("the finding never carries the text", () => {
    for (const text of [ABANDON, NSEC, XPRV, `seed ${HEX}`, CASHU_B_21]) expect(JSON.stringify(findSecret(text))).not.toContain(text.slice(-12));
  });
});

describe("what it lets through", () => {
  it.each([
    "hey, are you around later?",
    "Ok! See you at 7 🙂",
    "tudo bem? vamos almoçar amanhã",
    "The secret to good coffee is fresh beans and patience.",
    "My seed phrase is safe, don't worry, I wrote it on paper.",
    "I will buy a ticket for the concert this summer, want to join the group and grab dinner after?",
    "can you review the draft before friday? the budget section needs a second pair of eyes",
    // Eleven seed words are not a seed.
    "legal winner thank year wave sausage worth useful legal winner thank",
    "`sha256sum` says " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "txid " + "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    "commit 207bf023" + "a".repeat(32) + " fixes it",
    "The block hash 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f is the genesis block",
    "0x" + "de".repeat(32),
    NPUB,
    `my npub is ${NPUB}`,
    XPUB,
    "send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq please",
    "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 and 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    INVOICE,
    `pay this: ${INVOICE}`,
    "lnbcrt2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgp9rtqe3",
    "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS",
    "tips@ghostly.tools",
    INVITE,
    `join me: ${INVITE}`,
    "https://ghostly.tools/#/" + INVITE,
    "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbDNkZ3N0bGJ3bW1xY2h0OWZkNm5uZ3N6dm1wYTB5eWlmaDN6/3o7aD2saalBwwftBIY/giphy.gif",
    "https://web.archive.org/web/20091027003806/http://geocities.com/Area51/Nebula/1234/ghost.gif",
    "https://mempool.space/tx/4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    "creqApWF0gaNhdGVub3N0cmFheKlucHJvZmlsZTFxeTI4d3VtbjhnaGo3dW45ZDNzaGp0bnl2OWtoMnVld2Q5aHN6OW1od2RlbjV0ZTB3ZmprY2N0ZTljdXJ4dmVuOWVlaHFjdHJ2NWhzenJ0aHdkZW41dGUwZGVoaHh0bnZkYWtxcWd5ZHFodTN6N2hhbmdtMXh3NHhydnpkZDBycWl6cjF5eHFq",
    "cashu is great, try a mint",
    "",
  ])("%s", (text) => expect(findSecret(text)).toBeNull());

  it("a run of seed words whose checksum fails, inside other text", () => {
    // A 12-word checksum is 4 bits: a random run of seed words passes one time in 16. Prose never makes such runs
    // ("the", "a", "is", "to", "and", "of" are not on the list); a list of seed words that fails is let through.
    expect(findSecret("so we sang: about above absent absorb abstract absurd abuse access accident account accuse achieve, ok")).toBeNull();
    expect(findSecret(`note: ${MNEMONICS[0].replace("yellow", "yard")}`)).toBeNull();
  });
});

describe("how long it takes", () => {
  const time = (text: string) => {
    findSecret(text);
    const start = performance.now();
    for (let i = 0; i < 5; i++) findSecret(text);
    return (performance.now() - start) / 5;
  };
  const MAX = 16_384;
  it.each([
    ["prose", "the quick brown fox jumps over the lazy dog, and then some more words to read. ".repeat(250).slice(0, MAX)],
    // Every window fails its checksum, so the whole budget of checksums is spent.
    ["one seed word over and over", "zoo ".repeat(MAX / 4)],
    ["seed words only", `${MNEMONICS[4].replace("title", "zoo")} `.repeat(200).slice(0, MAX)],
    ["hex", "ab".repeat(MAX / 2)],
    ["hex words with context", `secret ${HEX} `.repeat(200).slice(0, MAX)],
    ["base58", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 ".repeat(500).slice(0, MAX)],
    ["WIF-shaped words", `${WIF.compressed.slice(0, -1)}X `.repeat(400).slice(0, MAX)],
    ["cashu-shaped text", `cashuB${"A".repeat(MAX)}`.slice(0, MAX)],
  ])("a 16 KiB message of %s is read in well under a frame", (_, text) => {
    expect(time(text)).toBeLessThan(50);
  });
});

describe("decodeCashu", () => {
  it("reads nothing from text that is not a token", () => {
    expect(decodeCashu("A", "bm90IGpzb24")).toBeNull();
    expect(decodeCashu("B", "////")).toBeNull();
    expect(decodeCashu("A", btoa(JSON.stringify({ token: [{ proofs: [{ amount: -1 }] }] })))).toBeNull();
    expect(decodeCashu("A", btoa(JSON.stringify({ token: [] })))).toBeNull();
  });
});
