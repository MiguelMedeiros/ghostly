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

/**
 * Whether a link's text would make a reader think it goes somewhere else: it names a host that is not the link's (nor
 * one the link's host sits under), or it holds an invisible or direction character, which can turn "moc.lapyap"
 * into "paypal.com" on screen. File names ("report.pdf", "Node.js") read as hosts too; the bubble then shows the
 * address, which is the safe side to err on.
 */
export function labelMisleads(label: string, url: string): boolean {
  const target = hostOf(url);
  if (!target) return true;
  if (new RegExp(INVISIBLE.source).test(label)) return true;
  for (const found of label.matchAll(ADDRESS)) {
    const written = found[0];
    const bare = written.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
    if (bare === written && !LOOKS_LIKE_HOST.test(bare)) continue;
    const host = hostOf(`https://${bare}`);
    if (!host) return true;
    if (host !== target && !target.endsWith(`.${host}`)) return true;
  }
  return false;
}

/** A label's words without its markers, for the chat list. */
function labelText(label: Segment[]): string {
  return label.map((s) => (s.type === "span" ? (s.style === "spoiler" ? SPOILER_PLAIN : labelText(s.children)) : s.text)).join("");
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
    return { data: { url, label: tokenizeInline(text, []), showUrl: labelMisleads(text, url) } };
  },
  plain(atom: Atom<"md-link", MdLinkData>) {
    return atom.data.showUrl ? shownUrl(atom.data.url) : labelText(atom.data.label);
  },
};
