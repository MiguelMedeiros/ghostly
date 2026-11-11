import { LINK_TRAILING, linkStop } from "@ghostly/core";
import type { Detector } from "./types";

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * A link ends where the sentence around it takes over: trailing punctuation ("see https://x.example/a.", "見て
 * https://x.example/a。", in any of the app's languages) and a closing bracket or quote the link did not open
 * ("(https://x.example/a)") are left as text, and so is a doubled `~~` or `||` closing the strike or spoiler the link
 * sits in.
 */
export function linkEnd(whole: string): string {
  const url = linkStop(whole);
  const count: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
  for (const c of url) if (c in count) count[c]++;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const opener = CLOSERS[last];
    if (LINK_TRAILING.test(last) || (opener && count[last] > count[opener])) {
      if (opener) count[last]--;
      end--;
    } else if ((last === "~" || last === "|") && url[end - 2] === last) end -= 2;
    else break;
  }
  return url.slice(0, end);
}

/**
 * Characters that draw as nothing, which can make a link read as another address: format characters (direction
 * marks and overrides, zero-width ones, the soft hyphen, tags, interlinear annotation, shorthand and musical format
 * controls), everything Unicode marks as ignorable by default (the grapheme joiner, the Hangul fillers, variation
 * selectors, the Khmer inherent vowels, the Mongolian free variation selectors), and the line and paragraph
 * separators. Spelled out as well as by property, so none of them depends on the engine's Unicode version.
 */
export const INVISIBLE =
  /[\p{Cf}\p{Default_Ignorable_Code_Point}\u115f\u1160\u180e\u2028\u2029\u3164\uffa0\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]|\u034f|[\u17b4\u17b5]|[\u180b-\u180d]|\u180f|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;

/**
 * A link as a bubble shows it. Plain ASCII whose host the browser reads as typed shows as typed. Anything else shows
 * as the browser reads it: the host in punycode (a look-alike "аpple.com" reads "xn--pple-43d.com"), escapes in it
 * decoded ("paypal.com%2Eevil.example" opens "paypal.com.evil.example") and other characters percent-encoded, so a
 * right-to-left override inside it cannot turn the address around. A user part ("www.paypal.com@evil.example")
 * is left out, so what reads as the host is the one the link opens. What no URL parser takes loses its invisible
 * characters.
 */
export function shownUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url.replace(INVISIBLE, ""); }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  }
  const typedHost = /^[a-z][a-z\d+.-]*:\/\/([^/?#\\]*)/i.exec(url)?.[1].replace(/:\d*$/, "").toLowerCase();
  return /^[\x21-\x7e]*$/.test(url) && typedHost === parsed.hostname ? url : parsed.href;
}

/** Web addresses, over http(s) only: `javascript:` and `data:` never become links. */
export const link: Detector<"link", { url: string }> = {
  kind: "link",
  pattern: /https?:\/\/\S+/gi,
  accept(match) {
    const url = linkEnd(match[0]);
    // "https://" and nothing else is not a place.
    if (url.length <= match[0].indexOf("//") + 2) return null;
    return { data: { url }, end: match.index + url.length };
  },
};
