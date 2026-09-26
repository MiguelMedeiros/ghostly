import type { Detector } from "./types";

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * A link ends where the sentence around it takes over: trailing punctuation ("see https://x.example/a.") and a
 * closing bracket or quote the link did not open ("(https://x.example/a)") are left as text, and so is a doubled
 * `~~` or `||` closing the strike or spoiler the link sits in.
 */
export function linkEnd(url: string): string {
  const count: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
  for (const c of url) if (c in count) count[c]++;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const opener = CLOSERS[last];
    if (/[.,;:!?'"*_>]/.test(last) || (opener && count[last] > count[opener])) {
      if (opener) count[last]--;
      end--;
    } else if ((last === "~" || last === "|") && url[end - 2] === last) end -= 2;
    else break;
  }
  return url.slice(0, end);
}

/** Direction and other invisible format characters, which can make a link read as another address. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A link as a bubble shows it. Plain ASCII shows as typed. Anything else shows as the browser reads it: the host
 * in punycode (a look-alike "аpple.com" reads "xn--pple-43d.com") and other characters percent-encoded, so a
 * right-to-left override inside it cannot turn the address around. What no URL parser takes loses its invisible
 * characters.
 */
export function shownUrl(url: string): string {
  if (/^[\x21-\x7e]*$/.test(url)) return url;
  try { return new URL(url).href; } catch { return url.replace(INVISIBLE, ""); }
}

/** Web addresses, over http(s) only: `javascript:` and `data:` never become links. */
export const link: Detector<"link", { url: string }> = {
  kind: "link",
  pattern: /https?:\/\/\S+/g,
  accept(match) {
    const url = linkEnd(match[0]);
    // "https://" and nothing else is not a place.
    if (url.length <= match[0].indexOf("//") + 2) return null;
    return { data: { url }, end: match.index + url.length };
  },
};
