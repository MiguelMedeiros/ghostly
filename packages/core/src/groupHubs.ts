import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "./bytes";
import { COMMUNITY_TOPOLOGY, freshHubs, rankHubs, type Hub } from "./communityRendezvous";
import { MEMBER_KEY } from "./groupCommits";

/**
 * Hubs in a private (mesh) group (WISP 902 · Group Mesh § Hubs). Up to `threshold` members a group is a full mesh, as
 * before. Past it, members that stay online (the Desktop app and the CLI, or members the admin pins) become **hubs**:
 * they keep edges with every other hub and with the members that ask them, and pass on every frame they take. The
 * other members keep edges with `hubsPerMember` hubs only. Frames are author-signed and sealed under the epoch key, and
 * hubs are members, so what a hub passes on is what any member hands on in a catch-up (§ Catch-up): it can withhold a
 * frame, never read more than it could already, alter or forge one.
 *
 * Where hubs are found is the community profile's machinery (`communityRendezvous.ts`): a sealed Pkarr **beacon**
 * listing them, and a **lobby** per hub where a member asks for an edge. The community derives both from the secret its
 * link carries; a private group has no such secret, so they derive from a rendezvous secret of the **current epoch**
 * (`meshRendezvous`). The beacon moves with every commit, and someone removed cannot read or write the next one.
 */
export const MESH_HUBS = {
  /** Members up to which a group stays a full mesh, whatever hubs there are. */
  threshold: 16,
  /** Hubs a member keeps edges with, when there are that many: one to spare, so losing a hub loses nothing. */
  hubsPerMember: 2,
  /** Hubs listed at most (the beacon's own bound). */
  maxHubs: COMMUNITY_TOPOLOGY.maxHubs,
  /** Members one hub holds before members prefer another: hubs with room first, a full one rather than none. */
  hubCapacity: COMMUNITY_TOPOLOGY.hubCapacity,
  /** Members the admin pins, and excludes, at most. */
  pinned: 8,
  excluded: 32,
} as const;

/** The `paired-groups` version an app announces when it takes part in a mesh group's hubs (it may pass frames on). */
export const GROUP_VERSION_HUBS = 4;

/**
 * The epoch's rendezvous secret, which `beaconKeys` and `lobbyKeys` take as the community takes its link's: HKDF-SHA-256
 * of the epoch secret, salted by the group id and the epoch, under a label of its own (it can never be the message key).
 */
export function meshRendezvous(epochSecret: Uint8Array, groupId: string, epoch: number): string {
  if (epochSecret.length !== 32) throw new Error("Invalid epoch secret");
  return toBase64Url(hkdf(sha256, epochSecret, utf8Encode(`${groupId}/${epoch}`), utf8Encode("ghostly-group-mesh/1 rendezvous"), 32));
}

/** What the admin says about hubs, in the group's metadata (`hubs` in the body): members pinned as hubs, and excluded. */
export interface MeshHubPolicy { pin: string[]; no: string[] }
export const NO_HUB_POLICY: MeshHubPolicy = { pin: [], no: [] };

/** A policy as the body carries it: distinct member keys, within the bounds, none both pinned and excluded. Null when it is not one. */
export function parseHubPolicy(raw: unknown): MeshHubPolicy | null {
  if (raw === undefined) return NO_HUB_POLICY;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { pin, no } = raw as Record<string, unknown>;
  const keys = (v: unknown, max: number): string[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max || !v.every(k => typeof k === "string" && MEMBER_KEY.test(k)) || new Set(v).size !== v.length) return null;
    return [...v as string[]].sort();
  };
  const p = keys(pin, MESH_HUBS.pinned), n = keys(no, MESH_HUBS.excluded);
  if (!p || !n || p.some(k => n.includes(k))) return null;
  return { pin: p, no: n };
}

/** The policy as the body writes it: nothing when it says nothing. */
export function wireHubPolicy(policy: MeshHubPolicy): MeshHubPolicy | undefined {
  return policy.pin.length || policy.no.length ? { pin: [...policy.pin].sort(), no: [...policy.no].sort() } : undefined;
}

/**
 * Whether a member may be a hub: in the roster, not excluded, and either pinned by the admin or on an app that stays
 * online (`staysOnline`, which only the member's own app knows; others go by what the beacon says).
 */
export function mayBeHub(key: string, policy: MeshHubPolicy, inRoster: (key: string) => boolean, staysOnline: boolean): boolean {
  return inRoster(key) && !policy.no.includes(key) && (staysOnline || policy.pin.includes(key));
}

/**
 * The hubs of the beacon a member counts on: fresh, in the roster, not excluded, not itself. Everyone filters the same
 * way, so a member the admin excluded, or someone removed, who lists itself anyway is listed for nobody.
 */
export function meshHubs(hubs: Hub[], me: string, policy: MeshHubPolicy, inRoster: (key: string) => boolean, now = Date.now()): Hub[] {
  return freshHubs(hubs, now).filter(h => h.key !== me && inRoster(h.key) && !policy.no.includes(h.key));
}

/**
 * The hubs a member keeps edges with: `hubsPerMember` of them, by rendezvous rank for this member, so the members
 * spread over the hubs and a hub that goes moves only its own members. First hubs with room that republished lately,
 * then full ones (a hub keeps an edge with every member, so a full one is only a busier one), then hubs that may be
 * gone (their app closed; they stay listed a while), and hubs to `avoid` (they did not take me) last.
 */
export function pickMeshHubs(me: string, hubs: Hub[], now = Date.now(), avoid: ReadonlySet<string> = new Set()): string[] {
  const lately = (h: Hub) => now - h.ts < COMMUNITY_TOPOLOGY.beaconEveryMs * 1.5;
  const room = (h: Hub) => h.load < MESH_HUBS.hubCapacity;
  const ranked = (list: Hub[]) => rankHubs(me, list.map(h => h.key));
  const tiers = [(h: Hub) => lately(h) && room(h), (h: Hub) => lately(h), () => true];
  const order: string[] = [];
  for (const tier of tiers) for (const key of ranked(hubs.filter(h => h.key !== me && !avoid.has(h.key) && tier(h)))) if (!order.includes(key)) order.push(key);
  for (const key of ranked(hubs.filter(h => h.key !== me && avoid.has(h.key)))) if (!order.includes(key)) order.push(key);
  return order.slice(0, MESH_HUBS.hubsPerMember);
}
