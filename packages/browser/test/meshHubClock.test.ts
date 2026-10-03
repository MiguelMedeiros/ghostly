import { describe, expect, it } from "vitest";
import { MESH_HUBS } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.send

/**
 * Hubs of a private group past 16 members (WISP 9xx · Group Mesh § Hubs) when one device's clock differs. A hub dates
 * its beacon entry by its own clock, and a member judged it by its own: a member whose clock was 90 s or more from the
 * hubs' saw no hub (their entries looked stale, or not come yet), and a hub whose clock was off was a hub to nobody.
 * On headless engines (`CommunityWorld`), each ticking by its own clock. The hub cases fail before the change (members
 * count on one hub only); a member that is not a hub, and saw none, got there all the same through the hubs' word
 * (`group-reach`), and its cases stay here so the clock learning never takes that away.
 */
const MINUTE = 60_000;
const SIZE = 18, HUBS = [3, 7], MEMBER = 10, HUB = 3;
/** The admin as a hub (a CLI daemon): its clock also dates the commits that let members in. */
const ADMIN_HUBS = [0, 7];

async function build(off: number, by: number, hubs: number[]) {
  const world = new CommunityWorld();
  const app = (i: number) => ({ staysOnline: hubs.includes(i), ...(i === off ? { clock: by } : {}) });
  const admin = world.add("admin", undefined, app(0));
  const id = await admin.groups.create("Clocks", "mesh");
  const link = await admin.groups.enableLink(id);
  const peers = [admin];
  for (let i = 1; i < SIZE; i++) {
    const p = world.add(`p${i}`, undefined, app(i));
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * MINUTE, 500);
    peers.push(p);
  }
  return { world, id, peers };
}

describe("hubs of a private group whose members' clocks differ", { timeout: 240_000 }, () => {
  it.each([
    ["a member's clock 90 s ahead", MEMBER, 90_000],
    ["a member's clock 90 s behind", MEMBER, -90_000],
    ["a member's clock two minutes ahead", MEMBER, 2 * MINUTE],
    ["a member's clock two minutes behind", MEMBER, -2 * MINUTE],
    ["a hub's clock 90 s ahead", HUB, 90_000],
    ["a hub's clock 90 s behind", HUB, -90_000],
    ["a hub's clock two minutes ahead", HUB, 2 * MINUTE],
    ["a hub's clock two minutes behind", HUB, -2 * MINUTE],
    ["the admin's clock two minutes ahead, the admin a hub", 0, 2 * MINUTE, ADMIN_HUBS],
    ["the admin's clock two minutes behind, the admin a hub", 0, -2 * MINUTE, ADMIN_HUBS],
  ])("%s: everyone counts on both hubs, and what each says reaches the others", async (_, off, by, hubs = HUBS) => {
    const { world, id, peers } = await build(off, by, hubs);
    const view = (p: Peer) => world.view(p, id)!;
    const hubKeys = hubs.map(i => view(peers[i]).myKey!).sort();
    const members = peers.filter((_, i) => !hubs.includes(i));
    const edges = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).length;
    // Every member sees both hubs (the one with the clock off too), reaches everyone, and keeps edges with its hubs only.
    const settled = () => peers.every(p => !!view(p).hubs && view(p).members.every(m => m.online))
      && members.every(p => view(p).members.filter(m => m.hub).map(m => m.key).sort().join() === hubKeys.join() && edges(p) <= MESH_HUBS.hubsPerMember + (p === peers[0] ? 1 : 0));
    const why = () => peers.filter(p => !view(p).hubs || !view(p).members.every(m => m.online) || (members.includes(p) && view(p).members.filter(m => m.hub).length !== 2))
      .map(p => `${p.name}: hubs ${JSON.stringify(view(p).hubs)} marked ${view(p).members.filter(m => m.hub).length} offline ${view(p).members.filter(m => !m.online).length} edges ${edges(p)}`).slice(0, 6).join("; ");
    await world.until(settled, 6 * MINUTE, 1000, why);
    // It stays so.
    await world.run(5 * MINUTE);
    expect(settled(), why()).toBe(true);
    const odd = peers[off], other = members.find(p => p !== odd && p !== peers[0])!;
    for (const [from, text] of [[odd, "from the odd clock"], [other, "to the odd clock"]] as const) {
      expect((await from.groups.send(id, text)).error).toBeNull();
      await world.until(() => peers.every(p => world.texts(p, id).includes(text)), MINUTE, 500,
        () => peers.filter(p => !world.texts(p, id).includes(text)).map(p => p.name).join(","));
    }
  });
});
