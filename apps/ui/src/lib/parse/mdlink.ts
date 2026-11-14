import { SPOILER_PLAIN, tokenizeInline } from "./inline";
import { INVISIBLE, shownUrl } from "./links";
import type { Atom, Detector, Segment } from "./types";

export interface MdLinkData {
  url: string;
  /** What the author wrote between the brackets, formatting read (no links or other atoms inside). */
  label: Segment[];
  /** True when the label reads as another address than the link's: the bubble shows the address instead. */
  showUrl: boolean;
}

/** The link's host as a browser reads it: lower case, punycode, without a leading "www.". */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Something in a label that reads as a web address or a domain: "ghostly.tools", "https://a.example/x", "1.2.3.4". */
const ADDRESS = /(?:[a-z][a-z\d+.-]{0,20}:\/\/)?[\p{L}\p{N}][\p{L}\p{N}-]{0,62}(?:\.[\p{L}\p{N}][\p{L}\p{N}-]{0,62}){1,8}/giu;
/** Ends in a top-level domain (letters), or is an IPv4 address. "v1.2", "3.14" and "e.g." are not hosts. */
const LOOKS_LIKE_HOST = /\.\p{L}[\p{L}\p{N}-]{1,62}$|^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** File extensions no top-level domain uses: "report.pdf", "Node.js" and "package.json" are names, not hosts. */
const NOT_A_TLD = /\.(?:[cm]?js|jsx|tsx?|json|css|html?|txt|log|csv|png|jpe?g|gif|svg|webp|toml|ya?ml|lock|wasm|pdf|rb|go)$/i;
/** Extensions that are country domains too (Moldova, Paraguay…): a file only as a path's last part ("docs/CHAT.md"). */
const FILE_IN_PATH = /\.(?:md|py|rs|sh)$/i;
/**
 * Characters a browser reads as the dot between a host's labels, and ones that only look like it (Unicode's
 * confusables of "." and the middle, raised and word-separator dots fonts draw like it). Read before NFKC ("˙" would
 * become a space and an accent) and after it ("･" becomes "・"). The combining dots stand alone, outside the class.
 */
const DOTS =
  /[\u00b7\u02d9\u0660\u06d4\u06f0\u0701\u0702\u0f0b\u0f0c\u1427\u16eb\u2022\u2024\u2027\u2219\u22c5\u2e30\u2e31\u2e33\u2e3c\u3002\u30fb\u318d\ua4f8\ua60e\ua78f\uff0e\uff61\u{10a50}\u2981]|\u0323|\u{1d16d}/gu;

/**
 * A whole emoji: a keycap ("1️⃣"), a flag drawn from tags (🏴 and its tag letters), or pictographs joined by zero-width
 * joiners, each with its variation selector or skin tone ("❤️", "👩🏽‍💻"). Their invisible parts are drawn as part of
 * the emoji, so they hide nothing; the same characters anywhere else still count.
 */
const EMOJI =
  /[#*0-9]️?⃣|\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}|\p{Extended_Pictographic}(?:[︎️]|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:[︎️]|\p{Emoji_Modifier})?)*/gu;

/**
 * Whether a link's text would make a reader think it goes somewhere else: it names a host that is not the link's (nor
 * one the link's host sits under), or it holds an invisible or direction character, which can turn "moc.lapyap"
 * into "paypal.com" on screen. The text is read as a browser would read a host ("ghostly。tools" and "ｇｈｏｓｔｌｙ.tools"
 * are "ghostly.tools"). File names are left alone ("report.pdf", "docs/CHAT.md"); anything else that reads as a
 * host counts, which errs on the safe side: the bubble shows the address.
 */
export function labelMisleads(label: string, url: string): boolean {
  const target = hostOf(url);
  if (!target) return true;
  if (new RegExp(INVISIBLE.source, "u").test(label.replace(EMOJI, ""))) return true;
  const text = label.replace(DOTS, ".").normalize("NFKC").replace(DOTS, ".");
  for (const found of text.matchAll(ADDRESS)) {
    const written = found[0];
    const bare = written.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
    if (bare === written) {
      if (!LOOKS_LIKE_HOST.test(bare) || NOT_A_TLD.test(bare)) continue;
      // "docs/CHAT.md": after a path's slash (not the "//" of an address).
      const at = found.index;
      if (FILE_IN_PATH.test(bare) && text[at - 1] === "/" && at > 1 && !/[/:]/.test(text[at - 2])) continue;
    }
    const host = hostOf(`https://${bare}`);
    if (!host) return true;
    if (host !== target && !target.endsWith(`.${host}`)) return true;
  }
  return false;
}

/** A label's words without its markers, for the chat list; `revealed` reads a spoiler's words as a tap shows them. */
function labelText(label: Segment[], revealed = false): string {
  return label
    .map((s) => (s.type === "span" ? (s.style === "spoiler" && !revealed ? SPOILER_PLAIN : labelText(s.children, revealed)) : s.text))
    .join("");
}

/**
 * `[text](https://…)`: the text as a link, over http(s) only (`[a](javascript:…)` stays text). The address may hold
 * one pair of brackets ("…/Foo_(bar)"); both parts are bounded, so the pattern stays linear.
 */
export const mdLink: Detector<"md-link", MdLinkData> = {
  kind: "md-link",
  pattern: /\[([^[\]\n]{1,200})\]\((https?:\/\/[^\s()<>]{1,4096}(?:\([^\s()<>]{0,256}\)[^\s()<>]{0,1024})?)\)/gi,
  accept(match) {
    const [, text, url] = match;
    if (!text.trim() || !hostOf(url)) return null;
    const label = tokenizeInline(text, []);
    // The written text, and the words the bubble draws: markers can split a host ("paypal.**com**") it shows whole.
    const showUrl = labelMisleads(text, url) || labelMisleads(labelText(label, true), url);
    return { data: { url, label, showUrl } };
  },
  plain(atom: Atom<"md-link", MdLinkData>) {
    return atom.data.showUrl ? shownUrl(atom.data.url) : labelText(atom.data.label);
  },
};
