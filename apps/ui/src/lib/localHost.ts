/**
 * A host that names this machine or the local network, as far as its spelling tells: `localhost`, `.local`,
 * `.internal`, a single label, private and reserved IP addresses. Previews are never made for these, and a page
 * on the internet may not point its picture at one. (Desktop also checks the addresses a name resolves to.)
 * In a module of its own, importing nothing: the extension's background worker reads it too.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return true;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  // Any IPv6 literal but a global unicast one (2000::/3), and none that embeds an IPv4 address.
  if (host.includes(":")) return !/^[23][0-9a-f]{0,3}:/.test(host) || host.includes(".") || /^2001:0?db8:/.test(host);
  return false;
}
