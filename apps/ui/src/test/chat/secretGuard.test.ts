import { describe, expect, it, vi } from "vitest";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";
import { decodeCashu, findSecret } from "../../lib/parse/secrets";
// The lists the composer loads as it opens.
import "../../lib/parse/seedLists";

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
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const base64url = (bytes: number[]) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
/**
 * A macaroon as LND serialises it (version 2): location "lnd", an identifier (version 3, root key id 0x01…, the
 * permissions), one caveat, and a signature of 0x01 bytes.
 */
const field = (type: number, bytes: number[]) => [type, bytes.length, ...bytes];
const MACAROON = [
  2, ...field(1, ascii("lnd")), ...field(2, [3, ...Array(16).fill(1), ...ascii("offchain:read,write onchain:read")]), 0,
  ...field(2, ascii("time-before 2030-01-01")), 0,
  0, ...field(6, Array(32).fill(1)),
];
const MACAROON_HEX = MACAROON.map((b) => b.toString(16).padStart(2, "0")).join("");
const MACAROON_BASE64 = base64(MACAROON);
const MACAROON_BASE64URL = base64url(MACAROON).replace(/=+$/, "");
/** Core Lightning runes: base64url of a 32-byte authcode (0x01… here) and the restrictions, unique id first. */
const RUNE = {
  master: base64url([...Array(32).fill(1), ...ascii("=0")]),
  restricted: base64url([...Array(32).fill(1), ...ascii("=3&method=listfunds&rate=60")]),
  alternatives: base64url([...Array(32).fill(1), ...ascii("=7&method^list|method^get|method=pay&pnameamount_msat<100000")]),
  bare: base64url(Array(32).fill(1)),
};
/** What a Japanese seed's words are separated by. */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

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

  /**
   * BIP39's lists in the app's other languages, as a wallet set to one of them shows its seed (Japanese with ideographic
   * spaces). Entropy 0x7f repeated, as the English vectors above.
   */
  const LISTS: [string, string[]][] = [
    ["Portuguese", portuguese], ["Spanish", spanish], ["French", french], ["Italian", italian], ["Japanese", japanese],
    ["Chinese (simplified)", simplifiedChinese], ["Chinese (traditional)", traditionalChinese],
  ];
  const seedIn = (list: string[], bytes: number) => entropyToMnemonic(new Uint8Array(bytes).fill(0x7f), list);

  it.each(LISTS)("a BIP39 seed in %s, of every length", (_, list) => {
    for (const bytes of [16, 20, 24, 28, 32]) {
      const seed = seedIn(list, bytes);
      expect(findSecret(seed)).toEqual({ kind: "mnemonic" });
      expect(findSecret(`seed: ${seed}`)).toEqual({ kind: "mnemonic" });
      expect(findSecret(seed.split(/\s/).map((w, i) => `${i + 1}. ${w}`).join("\n"))).toEqual({ kind: "mnemonic" });
    }
  });

  it.each(LISTS)("a BIP39 seed in %s, written in capitals, without accents or in composed letters", (_, list) => {
    const seed = seedIn(list, 16);
    for (const text of [seed.toUpperCase(), seed.normalize("NFD").replace(/\p{M}/gu, ""), seed.normalize("NFC")]) {
      expect(findSecret(text)).toEqual({ kind: "mnemonic" });
    }
  });

  it("a Japanese seed with ordinary spaces, or a message of only its words with one mistyped", () => {
    const seed = seedIn(japanese, 16);
    expect(findSecret(seed.replace(/\s/g, " "))).toEqual({ kind: "mnemonic" });
    const words = seed.split(IDEOGRAPHIC_SPACE);
    expect(findSecret([...words.slice(0, -1), words[0]].join(IDEOGRAPHIC_SPACE))).toEqual({ kind: "mnemonic" });
  });

  /**
   * A Polyseed, the 16-word seed Feather and Cake Wallet show for a Monero wallet: BIP39's English words with a checksum
   * of its own. Before, only a BIP39 checksum over 12 or 15 of its words caught one, by chance: about 3 in 10.
   */
  it.each([
    // 22 bytes of 0x11 and of 0x77, read as 16 words of 11 bits.
    ["baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain"],
    ["jazz roof tape upon jazz roof tape upon jazz roof tape upon jazz roof tape upon"],
  ])("a message that is only a 16-word Monero Polyseed: %s", (seed) => {
    expect(findSecret(seed)).toEqual({ kind: "mnemonic" });
    expect(findSecret(seed.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"))).toEqual({ kind: "mnemonic" });
    // Not inside other text: no checksum of BIP39's holds for it.
    expect(findSecret(`${seed} zoo`)).toBeNull();
    // One word sixteen times is still no seed.
    expect(findSecret("abandon ".repeat(16).trim())).toBeNull();
  });

  /**
   * Monero's classic seed, the one Monero GUI and monero-wallet-cli show: 25 words of Monero's own list, the last a
   * checksum word. These are the test wallets of Monero's functional tests (tests/functional_tests/transfer.py).
   */
  const MONERO_SEEDS = [
    "velvet lymph giddy number token physics poetry unquoted nibs useful sabotage limits benches lifestyle eden nitrogen anvil fewest avoid batch vials washing fences goat unquoted",
    "peeled mixture ionic radar utopia puddle buying illness nuns gadget river spout cavernous bounced paradise drunk looking cottage jump tequila melting went winter adjust spout",
    "dilute gutter certain antics pamphlet macro enjoy left slid guarded bogeys upload nineteen bomb jubilee enhanced irritate turnip eggs swung jukebox loudly reduce sedan slid",
  ];
  /** MyMonero's 13 words: the first 12 of the seed above and the checksum word electrum-words gives them. */
  const MYMONERO_SEED = "velvet lymph giddy number token physics poetry unquoted nibs useful sabotage limits useful";

  it.each(MONERO_SEEDS.map((seed) => [seed]))("a 25-word Monero seed: %s", (seed) => {
    expect(findSecret(seed)).toEqual({ kind: "mnemonic" });
    expect(findSecret(`my monero seed: ${seed}`)).toEqual({ kind: "mnemonic" });
    expect(findSecret(seed.toUpperCase().split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"))).toEqual({ kind: "mnemonic" });
  });

  it("a 13-word MyMonero seed, alone or after a label", () => {
    expect(findSecret(MYMONERO_SEED)).toEqual({ kind: "mnemonic" });
    expect(findSecret(`zoo ${MYMONERO_SEED} zoo`)).toEqual({ kind: "mnemonic" });
  });

  it("Monero's documented example seed, five of whose words are also BIP39's", () => {
    const seed = "sequence atlas unveil summon pebbles tuesday beer rudely snake rockets different fuselage woven tagged bested dented vegan hover rapid fawns obvious muppet randomly seasons randomly";
    expect(findSecret(seed)).toEqual({ kind: "mnemonic" });
    expect(findSecret(`my monero seed: ${seed} (keep it safe)`)).toEqual({ kind: "mnemonic" });
  });

  /**
   * Monero's lists in the app's other languages, as Monero GUI and monero-wallet-cli show a seed in them. Each is 32
   * bytes (i * 37 + 11) and MyMonero's 16 (i * 53 + 7) as electrum-words.cpp writes them, with its checksum over
   * the list's own prefix of each word (4 letters, Japanese 3, Chinese 1); never a key.
   */
  const MONERO_LISTS: [string, string, string][] = [
    ["Spanish",
      "lado pijama edición curar puré riqueza niño perfil grave engaño gimnasio miga pronto pegar lonja choque bicho guitarra arpa parte oferta cinco rendir grasa niño",
      "agua causa perico opinar mensaje breve mozo digno llegar fijo arco causa agua"],
    ["Portuguese",
      "motriz teosofico fucsia eventualidade utilizar zefiro ragu tanzaniano jingle generoso jambo paciente unheiro sugestoes oblongo ducto caquizeiro jururu baforada software roer echarpe vulva jihad unheiro",
      "airoso dioxido taoista rumoroso otite cisto pizzaria fiasco nublar iansa avizinhar dioxido pizzaria"],
    ["French",
      "occasion suite fuir facette trotter zeste religion soutenir magot gicler lors pour tour solo peigne dieu carie masque barbe sinus ronce distance visuel magie solo",
      "aise cure souvent rumeur pompier chemin quitter flan partir ivre balle cure souvent"],
    ["Italian",
      "noleggio svuotare famiglia donna uragano zoccolo riunione stoffa lanterna filmato invito privacy tulipano spugna patogeno condotto brontolo levitare auspicio sparire scimmia corleone virtuoso lampone levitare",
      "alfabeto circuito storia segreto porzione cammello recitare epilogo panorama gioiello atropina circuito circuito"],
    ["Japanese",
      "せんさい にわとり げんそう くふう のれん ひさしぶり つまらない にしき しふく こうない しちりん たれんと のがす なめらか たいうん ききて えんとつ しゃけん うがい なおす てほどき ぎしき はんきょう しはん にしき",
      "あんがい かゆい にせもの てんてき たぼう おこる ちたい けつえき そよかぜ さうな いわかん かゆい ちたい"],
    ["Chinese (simplified)",
      "苗 苯 兵 首 妻 祝 亿 丽 械 船 唱 捕 灌 拍 户 布 区 贵 比 枝 峰 难 愤 血 愤",
      "种 传 跨 童 纤 七 坦 远 纳 盐 正 传 种"],
  ];

  it.each(MONERO_LISTS)("a 25-word or 13-word Monero seed in %s", (_, seed, short) => {
    for (const text of [seed, `my monero seed: ${seed} (keep it safe)`, seed.toUpperCase().split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"),
      seed.normalize("NFD").replace(/\p{M}/gu, ""), `seed: ${short}`]) {
      expect(findSecret(text)).toEqual({ kind: "mnemonic" });
    }
  });

  it("Monero's own Portuguese test seed, each of whose words starts as an English one does", () => {
    // tests/unit_tests/mnemonics.cpp: only Portuguese's 4-letter prefixes make "gnostico" its checksum word.
    const seed = "cinzento luxuriante leonardo gnostico digressao cupula fifa broxar iniquo louvor ovario dorsal ideologo besuntar decurso rosto susto lemure unheiro pagodeiro nitroglicerina eclusa mazurca bigorna gnostico";
    expect(findSecret(`seed: ${seed}`)).toEqual({ kind: "mnemonic" });
  });

  it("an ordinary 25-word sentence, or one whose last word repeats an earlier one, is not a Monero seed", () => {
    expect(findSecret("we should meet at the cafe near the old bridge after work on friday so we can talk about the trip and the plan today")).toBeNull();
    expect(findSecret("tuesday dinner was lovely thanks again for cooking the pasta and the salad we should do it soon maybe at home next week on tuesday")).toBeNull();
  });

  it("a message that is only 25 Monero seed words, even with the checksum word mistyped", () => {
    const typo = MONERO_SEEDS[0].replace(/unquoted$/, "fences");
    expect(findSecret(`${typo} zoo`)).toBeNull(); // checksum fails and the run is not the whole message
    expect(findSecret(typo)).toEqual({ kind: "mnemonic" });
    // One word 25 or 13 times always passes Monero's checksum, and is still no seed.
    expect(findSecret("abbey ".repeat(25).trim())).toBeNull();
    expect(findSecret(`seed: ${"abbey ".repeat(13).trim()}`)).toBeNull();
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
    // A Monero wallet's keys as Cake Wallet, MyMonero and monero-wallet-cli label them: the spend key is the whole
    // wallet, the view key every payment it receives.
    ["Private spend key: …", `Private spend key: ${HEX}`],
    ["Private view key: …", `Private view key:\n${HEX}`],
    ["private_spend_key: …", `private_spend_key: ${HEX}`],
    ["Spend key (private): …", `Spend key (private): ${HEX}`],
    ["View key (private): …", `View key (private): ${HEX}`],
  ])("64-hex next to a word that says what it is: %s", (_, text) => expect(findSecret(text)).toEqual({ kind: "hex-key" }));

  it.each([
    ["an LND macaroon in hex, as the LND source asks for it", MACAROON_HEX],
    ["an LND macaroon in hex after a label", `macaroon: ${MACAROON_HEX}`],
    ["an LND macaroon in base64", MACAROON_BASE64],
    ["an LND macaroon in an lndconnect URI", `lndconnect://node.example:10009?cert=MIIC&macaroon=${MACAROON_BASE64URL}`],
    ["a Core Lightning master rune", RUNE.master],
    ["a Core Lightning rune with restrictions", `rune: ${RUNE.restricted}`],
    ["a Core Lightning rune with alternatives", RUNE.alternatives],
    ["a rune with no restriction, beside the word", `my rune ${RUNE.bare}`],
    ["a rune with its padding taken off, beside the word", `rune=${RUNE.master.replace(/=+$/, "")}`],
    ["a bitcoind cookie", `__cookie__:${HEX}`],
    ["a bitcoind rpcpassword", `rpcpassword=${HEX}`],
    ["the RPC password or cookie field's words", `RPC password or cookie: ${HEX}`],
    ["a .cookie file's contents after its name", `.cookie ${HEX}`],
  ])("a login to a node: %s", (_, text) => expect(findSecret(text)).toEqual({ kind: "node-login" }));

  it("64 hex digits beside \"password\" are a key", () => {
    expect(findSecret(`password ${HEX}`)).toEqual({ kind: "hex-key" });
  });

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
    for (const text of [ABANDON, NSEC, XPRV, `seed ${HEX}`, CASHU_B_21, MACAROON_HEX, RUNE.master]) expect(JSON.stringify(findSecret(text))).not.toContain(text.slice(-12));
  });
});

describe("a secret with characters that take no room on screen inside it", () => {
  // What a page, a PDF or a terminal leaves in a long string, and what a reader takes out in one step.
  const MARKS: [string, string][] = [
    ["a zero-width space", "\u200b"],
    ["a soft hyphen", "\u00ad"],
    ["a word joiner", "\u2060"],
    ["a zero-width joiner", "\u200d"],
    ["a byte order mark", "\ufeff"],
    ["a control character", "\u0001"],
    ["a variation selector", "\ufe0f"],
  ];
  /** `text` with `mark` after every `every` characters of it. */
  const broken = (text: string, mark: string, every = 8) => text.match(new RegExp(`.{1,${every}}`, "gs"))!.join(mark);

  describe.each(MARKS)("%s", (_, mark) => {
    it.each([
      ["an nsec", broken(NSEC, mark), "nsec"],
      ["an nsec in a sentence", `here is my key ${broken(NSEC, mark, 30)} ok`, "nsec"],
      ["a compressed WIF", broken(WIF.compressed, mark), "bitcoin-key"],
      ["an uncompressed WIF", `import this: ${broken(WIF.uncompressed, mark, 25)}`, "bitcoin-key"],
      ["an xprv", broken(XPRV, mark), "bitcoin-key"],
      ["an xprv with one mark in its prefix", `xp${mark}rv${XPRV.slice(4)}`, "bitcoin-key"],
      ["64 hex digits beside \"private key\"", `private key: ${broken(HEX, mark)}`, "hex-key"],
      ["128 hex digits beside \"seed\"", `seed ${broken("ab".repeat(64), mark, 50)}`, "hex-key"],
      ["64 hex digits beside a broken \"secret\"", `${HEX} is the sec${mark}ret`, "hex-key"],
      ["a macaroon in hex", broken(MACAROON_HEX, mark, 40), "node-login"],
      ["a rune", broken(RUNE.restricted, mark), "node-login"],
      ["a bitcoind cookie", broken(`__cookie__:${HEX}`, mark), "node-login"],
      ["a seed with marks inside its words", broken(MNEMONICS[0], mark, 3), "mnemonic"],
      ["a seed with marks for spaces", MNEMONICS[1].split(" ").join(mark), "mnemonic"],
    ])("%s", (_, text, kind) => expect(findSecret(text)).toEqual({ kind }));

    it("a Cashu token, with its amount still decoded here", () => {
      expect(findSecret(broken(CASHU_B_21, mark))).toEqual({ kind: "cashu", amount: 21, unit: "sat" });
      expect(findSecret(`for you cas${mark}huA${cashuA([100], "usd").slice(6)} thanks`)).toEqual({ kind: "cashu", amount: 100, unit: "usd" });
      expect(findSecret(`${cashuA([4])}${mark}`)).toEqual({ kind: "cashu", amount: 4, unit: "sat" });
    });

    it("what is not a secret is still not one", () => {
      for (const text of [
        broken("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", mark),
        `txid ${broken("4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b", mark)}`,
        broken(NPUB, mark),
        broken(XPUB, mark),
        broken(INVOICE, mark),
        broken(INVITE, mark),
        broken("The secret to good coffee is fresh beans and patience.", mark),
        broken("legal winner thank year wave sausage worth useful legal winner thank", mark, 3),
      ]) expect(findSecret(text)).toBeNull();
    });
  });

  it("the finding never carries the text", () => {
    for (const text of [NSEC, XPRV, `seed ${HEX}`, CASHU_B_21]) expect(JSON.stringify(findSecret(broken(text, "\u200b")))).not.toContain(text.slice(-6));
  });

  it("a line break inside a string is not taken out: it shows", () => {
    expect(findSecret(broken(NSEC, "\n"))).toBeNull();
    expect(findSecret(`sha256\n${HEX}\nseed`)).toEqual({ kind: "hex-key" }); // as before: the word is close by
    expect(findSecret(`${HEX}\u200b\nabc`)).toBeNull();
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
    // A Monero wallet's public keys are written with the same words.
    "Spend key (public): " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Public view key: " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "spend key " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Monero tx id 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
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
    // Base64 and other long strings that are not a login to a node.
    "integrity=\"sha256-n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=\"",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "https://example.com/blog/this-is-a-very-long-article-title-for-the-blog-and-more",
    "this_is_a_rather_long_identifier_name_in_some_code_base = 1",
    "the rune on the old stone said " + "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    "macaroons and cookies for dessert, " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" + " is the hash",
    "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297",
    "02" + "01".repeat(32) + " is the node's pubkey",
    "0201036c6e64 is how a macaroon starts",
    "",
  ])("%s", (text) => expect(findSecret(text)).toBeNull());

  it("one word said over and over, however its checksum falls (Linux Desktop hunt: \"long line word word … end\")", () => {
    // "word" twelve times passes a 12-word checksum (one run in 16 does): a repeated word is never a seed.
    expect(findSecret(`long line ${"word ".repeat(80)}end`)).toBeNull();
    for (const times of [12, 15, 18, 21, 24, 30]) {
      expect(findSecret("word ".repeat(times).trim())).toBeNull();
      expect(findSecret(`x ${"word ".repeat(times)}y`)).toBeNull();
    }
    // A seed of mostly one word still counts on its own, after a label or among other seed words.
    expect(findSecret(`seed ${ABANDON}`)).toEqual({ kind: "mnemonic" });
    expect(findSecret(`zoo ${ABANDON} zoo`)).toEqual({ kind: "mnemonic" });
  });

  it.each([
    ["Portuguese", "amanhã eu vou levar o bolo para a festa da escola, você pode buscar as crianças às cinco?"],
    ["Spanish", "mañana voy a llevar el pastel a la fiesta de la escuela, ¿puedes recoger a los niños a las cinco?"],
    ["French", "demain je vais apporter le gâteau à la fête de l'école, tu peux aller chercher les enfants à cinq heures ?"],
    ["Italian", "domani porto la torta alla festa della scuola, puoi andare a prendere i bambini alle cinque?"],
    ["Japanese", "明日は学校のお祭りにケーキを持っていくので、五時に子供たちを迎えに行ってくれる？"],
    ["Chinese", "明天我要把蛋糕带到学校的聚会上，你能五点去接孩子们吗？"],
  ])("ordinary %s is not a seed", (_, text) => {
    expect(findSecret(text)).toBeNull();
  });

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
    ["Spanish seed words only", `${spanish.slice(0, 23).join(" ")} `.repeat(200).slice(0, MAX)],
    ["Japanese seed words only", `${japanese.slice(0, 23).join(IDEOGRAPHIC_SPACE)}${IDEOGRAPHIC_SPACE}`.repeat(200).slice(0, MAX)],
    ["Monero's Chinese seed words only", "苗 苯 兵 首 妻 祝 亿 丽 械 船 唱 捕 灌 拍 户 布 区 贵 比 枝 峰 难 愤 血 ".repeat(400).slice(0, MAX)],
    ["hex", "ab".repeat(MAX / 2)],
    ["hex words with context", `secret ${HEX} `.repeat(200).slice(0, MAX)],
    ["base58", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 ".repeat(500).slice(0, MAX)],
    ["WIF-shaped words", `${WIF.compressed.slice(0, -1)}X `.repeat(400).slice(0, MAX)],
    ["cashu-shaped text", `cashuB${"A".repeat(MAX)}`.slice(0, MAX)],
    ["hex with a zero-width space every few digits", "abcdef01\u200b".repeat(MAX / 9)],
    ["seed words with a soft hyphen in each", "zo\u00ado ".repeat(MAX / 5)],
  ])("a 16 KiB message of %s is read in well under a frame", (_, text) => {
    expect(time(text)).toBeLessThan(50);
  });

  it("folds a text once for the other languages' lists, not once per list", () => {
    // The composer reads its draft at every keystroke: 13 folds of a 16 KiB Portuguese draft took ~16 ms of each key.
    const text = "amanhã eu vou levar o bolo para a festa da escola, você pode buscar as crianças às cinco?";
    findSecret(text); // the lists are read into their indices the first time
    const normalize = vi.spyOn(String.prototype, "normalize");
    try {
      findSecret(text);
      expect(normalize).toHaveBeenCalledTimes(1);
    } finally {
      normalize.mockRestore();
    }
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
