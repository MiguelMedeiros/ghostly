import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorText } from "../../lib/errorText";
import { textDirection } from "../../lib/documentLanguage";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES, flatten, lookup } from "./locales";

// covers: app.i18n

/*
 * A Latin token in a right-to-left sentence whose own punctuation sits at its edge (https://, did:<method>:<identifier>,
 * fed11…) is drawn backwards: the punctuation between the token and the Arabic words (or the end of the line) takes
 * the sentence's direction, so `https://` showed as `//:https` and `did:<method>:<identifier>` as
 * `<did:<method>:<identifier`. Such a token is written between U+2066 (left-to-right isolate) and U+2069 (pop
 * directional isolate), as `\u2066…\u2069` in the JSON: escaped, never as the raw invisible characters.
 */

const LRI = "\u2066";
const PDI = "\u2069";
const LOCALES_DIR = join(fileURLToPath(import.meta.url), "../../../locales");

/** Keys whose token is drawn left to right another way. */
const ELSEWHERE: Record<string, string> = {
  // The code block's warning draws its marker as an element of its own (CodeBlock's note, ghostly#5652).
  "chat.rich.hiddenChars": "an element of its own",
};

/**
 * The tokens of a string, isolated runs left out, that are written left to right and end (or start) on punctuation of
 * their own: a `/ < > =` after the last Latin letter or digit, an ellipsis that belongs to the token (inside
 * parentheses, or after a `: / =`), or a `< … /` right before it. A `{{value}}` counts as Latin; an ellipsis that ends
 * a sentence (`MP4…`, `{{name}}…`) and a colon or bracket of the sentence are left alone.
 */
function looseTokens(text: string): string[] {
  const bare = text.replace(new RegExp(`${LRI}[^${PDI}]*${PDI}`, "g"), " ");
  return bare.split(/\s+/).filter((token) => {
    const latin = token.replace(/\{\{\w+\}\}/g, "X");
    const tail = /[A-Za-z0-9][^A-Za-z0-9\u0600-\u06ff]*$/.exec(latin);
    const end = tail ? tail[0].slice(1) : "";
    const before = tail ? latin.slice(0, tail.index + 1) : "";
    if (/[/<>=]/.test(end)) return true;
    if (/^…\)|[:/=]…/.test(end) || (end.includes("…") && /[:/=]/.test(before))) return true;
    return /^\(?[<…/]+[A-Za-z]/.test(latin);
  });
}

const arabic = [...flatten(LOCALES.ar)].filter((entry): entry is [string, string] => typeof entry[1] === "string");

/** The keys the report named, with their token. */
const NAMED: readonly (readonly [string, string])[] = [
  ["errors.proof.didNotDid", "did:<method>:<identifier>"],
  ["errors.proof.didEnter", "did:key:z6Mk…"],
  ["errors.relays.useHttps", "https://"],
  ["errors.relays.useWss", "wss://"],
  ["errors.turn.notAddress", "turn:host:port"],
  ["boot.trySecure", "https://"],
  ["wallet.cashu.addMintPlaceholder", "https://…"],
  ["identities.nostr.picturePlaceholder", "https://…"],
  ["wallet.source.providers.core-lightning.description", "wss://"],
  ["wallet.source.providers.core-lightning.fields.url.help", "bind-addr=ws:…"],
];

describe("Latin tokens in right-to-left strings", () => {
  it("only Arabic is drawn right to left", () => {
    expect(LANGUAGES.filter((language) => textDirection(language) === "rtl")).toEqual(["ar"]);
  });

  it("are isolated left to right wherever their own punctuation sits at their edge", () => {
    const loose = arabic.filter(([key, text]) => !ELSEWHERE[key] && looseTokens(text).length).map(([key, text]) => `${key}: ${looseTokens(text).join(" ")}`);
    expect(loose).toEqual([]);
  });

  it.each(NAMED)("%s holds %s isolated", (key, token) => {
    expect(lookup("ar", key)).toContain(`${LRI}${token}${PDI}`);
    expect(lookup("en", key)).toContain(token);
  });

  it("says a DID typed wrong with its pattern left to right", () => {
    const text = errorText(new Error("That is not a DID: it looks like did:<method>:<identifier>"), translateWith(LOCALES.ar, "ar"));
    expect(text.endsWith(`${LRI}did:<method>:<identifier>${PDI}`)).toBe(true);
    expect(text.replace(/[\u2066\u2069]/g, "")).toBe("هذا ليس DID: شكله did:<method>:<identifier>");
  });

  it("open and close each isolate within the string", () => {
    const unbalanced = arabic.filter(([, text]) => text.replace(new RegExp(`${LRI}[^${LRI}${PDI}]*${PDI}`, "g"), "").match(/[\u2066\u2069]/)).map(([key]) => key);
    expect(unbalanced).toEqual([]);
  });

  it.each(LANGUAGES.filter((language) => language !== "ar"))("are left as they are in %s, which is drawn left to right", (language) => {
    const isolated = [...flatten(LOCALES[language])].filter(([, text]) => typeof text === "string" && /[\u2066\u2069]/.test(text)).map(([key]) => key);
    expect(isolated).toEqual([]);
  });

  it("are escaped in the JSON files, as every direction mark is (npm run locales:sort), not written raw", () => {
    const raw = LANGUAGES.flatMap((language) => readdirSync(join(LOCALES_DIR, language))
      .filter((file) => file.endsWith(".json") && /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(readFileSync(join(LOCALES_DIR, language, file), "utf8")))
      .map((file) => `${language}/${file}`));
    expect(raw).toEqual([]);
  });
});
