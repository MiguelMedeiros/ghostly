import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECT_EVIDENCE_MS, DIRECT_OWN_ATTEMPTS, DIRECT_PEERS, DirectPathWatch, directBlocked, symmetricNat, type DirectFailure } from "../src/directPath";

// covers: transport.direct-blocked

const NOW = 1_800_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => void vi.useRealTimers());

const failure = (peer: string, kind: DirectFailure["kind"], ago = 0): DirectFailure => ({ peer, kind, at: NOW - ago });
const srflx = (address: string, port: number) => `a=candidate:2 1 udp 1677729535 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0`;
const HOST = "a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host";

describe("the rule: when this device's attempts say direct connections are blocked", () => {
  it("one failed dial says nothing, of any kind", () => {
    for (const kind of ["no-public", "symmetric", "no-path"] as const) expect(directBlocked([failure("a", kind)], NOW), kind).toBe(false);
  });

  it(`${DIRECT_OWN_ATTEMPTS} attempts with this device's own evidence are enough, with one contact`, () => {
    expect(directBlocked([failure("a", "no-public"), failure("a", "no-public")], NOW)).toBe(true);
    expect(directBlocked([failure("a", "symmetric"), failure("a", "no-public")], NOW)).toBe(true);
  });

  it(`a path that failed needs ${DIRECT_PEERS} different contacts: one contact may be the one behind the VPN`, () => {
    const one = Array.from({ length: 10 }, () => failure("a", "no-path"));
    expect(directBlocked(one, NOW)).toBe(false);
    // The same person as a contact and as a member of a group is two keys: still not enough.
    expect(directBlocked([...one, failure("a-in-a-group", "no-path")], NOW)).toBe(false);
    expect(directBlocked([failure("a", "no-path"), failure("b", "no-path"), failure("c", "no-path")], NOW)).toBe(true);
    // One attempt of its own evidence counts as a contact among them.
    expect(directBlocked([failure("a", "no-path"), failure("b", "no-path"), failure("c", "no-public")], NOW)).toBe(true);
  });

  it("evidence older than the window says nothing about the network now", () => {
    const old = [failure("a", "no-public", DIRECT_EVIDENCE_MS), failure("a", "no-public")];
    expect(directBlocked(old, NOW)).toBe(false);
    expect(directBlocked([failure("a", "no-public", DIRECT_EVIDENCE_MS - 1), failure("a", "no-public")], NOW)).toBe(true);
  });
});

describe("a NAT that maps each destination apart, read from this device's own candidates", () => {
  it("one address and port, however many STUN servers were asked, is a mapping that holds", () => {
    expect(symmetricNat([HOST, srflx("203.0.113.7", 40000)].join("\r\n"))).toBe(false);
    expect(symmetricNat("")).toBe(false);
    expect(symmetricNat(null)).toBe(false);
  });

  it("two ports on one address may be two interfaces behind one router: not enough", () => {
    expect(symmetricNat([srflx("203.0.113.7", 40000), srflx("203.0.113.7", 40001)].join("\r\n"))).toBe(false);
    // An IPv4 and an IPv6 address, or two networks: one port each.
    expect(symmetricNat([srflx("203.0.113.7", 40000), srflx("2001:db8::7", 40001), srflx("198.51.100.9", 40002)].join("\r\n"))).toBe(false);
  });

  it("three ports on one address is a port per destination", () => {
    expect(symmetricNat([HOST, srflx("203.0.113.7", 40000), srflx("203.0.113.7", 40001), srflx("203.0.113.7", 40002)].join("\r\n"))).toBe(true);
    // Host candidates never count, whatever their ports.
    expect(symmetricNat([HOST, HOST.replace("50000", "50001"), HOST.replace("50000", "50002")].join("\r\n"))).toBe(false);
  });
});

describe("DirectPathWatch", () => {
  it("says blocked once the evidence is consistent, and tells each change once", () => {
    const changes: boolean[] = [];
    const watch = new DirectPathWatch(blocked => void changes.push(blocked));
    watch.note("a", "no-public");
    expect(watch.blocked).toBe(false);
    watch.note("a", "no-public");
    watch.note("b", "no-path");
    expect(watch.blocked).toBe(true);
    expect(changes).toEqual([true]);
    watch.close();
  });

  it("a connection that opens clears it, and nothing shows while one is open", () => {
    const changes: boolean[] = [];
    const watch = new DirectPathWatch(blocked => void changes.push(blocked));
    watch.note("a", "no-public"); watch.note("a", "no-public");
    watch.note("b", "open");
    expect(watch.blocked).toBe(false);
    expect(changes).toEqual([true, false]);
    // A contact behind a VPN, as a contact and in two groups, while another contact is connected directly: nothing.
    for (const key of ["v", "v-group-1", "v-group-2"]) watch.note(key, "no-path");
    expect(watch.blocked).toBe(false);
    // That connection ends (the network changed under it): the failures since then count.
    watch.note("b", "closed");
    expect(watch.blocked).toBe(true);
    expect(changes).toEqual([true, false, true]);
    watch.close();
  });

  it("a change of network clears it", () => {
    const changes: boolean[] = [];
    const watch = new DirectPathWatch(blocked => void changes.push(blocked));
    watch.note("a", "symmetric"); watch.note("b", "symmetric");
    watch.reset();
    expect(watch.blocked).toBe(false);
    watch.note("a", "symmetric");
    expect(watch.blocked).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("clears by itself when the evidence ages out", () => {
    const changes: boolean[] = [];
    const watch = new DirectPathWatch(blocked => void changes.push(blocked));
    watch.note("a", "no-public");
    vi.advanceTimersByTime(10 * 60_000);
    watch.note("a", "no-public");
    expect(changes).toEqual([true]);
    // The first one ages out: one attempt is left, which is not enough.
    vi.advanceTimersByTime(DIRECT_EVIDENCE_MS - 10 * 60_000 + 1_000);
    expect(watch.blocked).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});
