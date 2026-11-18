/**
 * Names only a local network answers (RFC 6762, RFC 8375, ICANN's .internal, and the usual router and company ones).
 * A copy of packages/core/src/localNames.ts, as this module imports nothing; the same as Desktop's
 * apps/desktop/src/local_names.rs (src/test/chat/linkPreviewParse.test.ts pins all three).
 */
export const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "home.arpa", "localdomain", "intranet", "corp"] as const;

/**
 * A host that names this machine or the local network, as far as its spelling tells: a name under a local suffix
 * (`localhost`, `.local`, `.lan`, `.home`, `.corp`, …), a single label, private and reserved IP addresses. Previews
 * are never made for these, a page on the internet may not point its picture at one, and a contact's app may not open
 * one. (Desktop also checks the addresses a name resolves to.)
 * In a module of its own, importing nothing: the extension's background worker reads it too.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return true;
  if (LOCAL_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  // Any IPv6 literal but a global unicast one (2000::/3: a first group of four digits, as `2::` is `0002::`), none
  // that embeds an IPv4 address (dotted, 6to4 2002::/16, Teredo 2001::/32: `new URL()` writes them all in hex), and
  // no documentation one (2001:db8::/32).
  if (host.includes(":")) {
    return !/^[23][0-9a-f]{3}:/.test(host) || host.includes(".") || host.startsWith("2002:") || /^2001:(0{0,4}|0{0,3}db8):/.test(host);
  }
  return false;
}
