import { decodeDnsAnswers, readDnsName } from "./dns";
import { normalizeDomain } from "./domainProofs";

/**
 * Pubky's PKDNS records, read (https://pubky.org). A Pubky key's signed Pkarr packet names its homeserver in an
 * HTTPS (or SVCB) record at `_pubky` whose target is the homeserver's own key; the homeserver's packet names, in
 * HTTPS records at its root, where it answers: its Pubky TLS endpoint (target ".", for native clients) and an ICANN
 * host name for browsers. The Pubky SDK resolves exactly this. Packets reach these functions already checked
 * against their key (`openRelayPayload`); nothing here trusts a host or URL from anywhere else.
 */

const SVCB = 64;
const HTTPS = 65;
/** SvcParamKey "port" (RFC 9460). */
const PORT = 3;
const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

export interface SvcbRecord {
  /** The owner name, lowercase, without a trailing dot (a Pkarr packet's names end in its key). */
  name: string;
  priority: number;
  /** The target name, lowercase; "" is "." (the owner itself). */
  target: string;
  /** SvcParams by key, raw. */
  params: Map<number, Uint8Array>;
}

const u16 = (data: Uint8Array, at: number) => (data[at] << 8) | data[at + 1];

/** Every SVCB and HTTPS record of a DNS packet, in packet order. Throws on a malformed one. */
export function decodeSvcbRecords(dnsPacket: Uint8Array): SvcbRecord[] {
  const records: SvcbRecord[] = [];
  for (const answer of decodeDnsAnswers(dnsPacket)) {
    if (answer.type !== SVCB && answer.type !== HTTPS) continue;
    const end = answer.offset + answer.length;
    if (answer.length < 3) throw new Error("SVCB record too short");
    const priority = u16(dnsPacket, answer.offset);
    const { name: target, next } = readDnsName(dnsPacket, answer.offset + 2);
    if (next > end) throw new Error("SVCB target out of bounds");
    const params = new Map<number, Uint8Array>();
    for (let at = next; at < end;) {
      if (at + 4 > end) throw new Error("SVCB parameter out of bounds");
      const key = u16(dnsPacket, at), length = u16(dnsPacket, at + 2);
      at += 4;
      if (at + length > end) throw new Error("SVCB parameter out of bounds");
      if (!params.has(key)) params.set(key, dnsPacket.slice(at, at + length));
      at += length;
    }
    records.push({ name: answer.name.toLowerCase(), priority, target: target.toLowerCase(), params });
  }
  return records;
}

/** The homeserver a Pubky key's packet names: the z-base-32 key its `_pubky` record points at, or undefined. */
export function pubkyHomeserverOf(dnsPacket: Uint8Array, userZ32: string): string | undefined {
  // Like the SDK: the first `_pubky` record. Pkarr stores names with the key appended; accept the relative form too.
  const record = decodeSvcbRecords(dnsPacket).find(r => r.name === `_pubky.${userZ32}` || r.name === "_pubky");
  return record && Z32.test(record.target) ? record.target : undefined;
}

/** Where a homeserver answers browsers: a public host name and, when its record says so, a port. */
export interface HomeserverEndpoint { host: string; port?: number }

/**
 * The homeserver's web endpoint from its own packet: of the HTTPS/SVCB records at its root, the lowest priority one
 * whose target is a public ICANN host name (not ".", not another Pkarr key, not a name that only works on private
 * networks, which would point a contact's app inward), with its port parameter. Undefined when there is none.
 */
export function homeserverWebEndpoint(dnsPacket: Uint8Array, homeserverZ32: string): HomeserverEndpoint | undefined {
  const records = decodeSvcbRecords(dnsPacket)
    .filter(r => (r.name === homeserverZ32 || r.name === "") && r.priority > 0)
    .sort((a, b) => a.priority - b.priority);
  for (const r of records) {
    if (!r.target || Z32.test(r.target.split(".")[0])) continue;
    let host: string;
    try { host = normalizeDomain(r.target); } catch { continue; }
    const port = r.params.get(PORT);
    if (port && port.length !== 2) continue;
    const number = port ? u16(port, 0) : undefined;
    if (number === 0) continue;
    return number === undefined || number === 443 ? { host } : { host, port: number };
  }
  return undefined;
}

/**
 * A DNS packet of SVCB/HTTPS records, the way Pkarr stores them (names with the key appended, targets
 * uncompressed). For tests and test services: Ghostly itself never publishes these.
 */
export function encodeSvcbPacket(records: { name: string; priority: number; target: string; port?: number; type?: 64 | 65 }[]): Uint8Array {
  const name = (value: string) => {
    const labels = value.split(".").filter(Boolean).map(l => new TextEncoder().encode(l));
    return Uint8Array.from([...labels.flatMap(l => [l.length, ...l]), 0]);
  };
  const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const bytes: number[] = [0, 0, 0x80, 0, 0, 0, ...be16(records.length), 0, 0, 0, 0];
  for (const r of records) {
    const rdata = [...be16(r.priority), ...name(r.target), ...(r.port === undefined ? [] : [...be16(PORT), 0, 2, ...be16(r.port)])];
    bytes.push(...name(r.name), ...be16(r.type ?? HTTPS), 0, 1, 0, 0, 0x0e, 0x10, ...be16(rdata.length), ...rdata);
  }
  return Uint8Array.from(bytes);
}
