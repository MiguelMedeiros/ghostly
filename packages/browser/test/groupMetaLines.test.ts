import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.catch-up

const PIC = "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0x00, 0x02, 1, 0xff, 0xd9));

/**
 * Four members, Dave away (network cut with the app running, or the app closed): Bob and Carol write 3 lines, Alice
 * renames the group or changes its picture, they write 3 more, and so on for each change. Dave's history and Carol's,
 * once Dave is back.
 */
async function backFromAway(mode: "mesh" | "community", way: "cut" | "restart", changes: ("rename" | "picture")[]) {
  const world = mode === "mesh" ? new CommunityWorld(undefined, null) : new CommunityWorld();
  const peers = ["alice", "bob", "carol", "dave"].map(n => world.add(n));
  const [alice, bob, carol, dave] = peers;
  const id = mode === "mesh" ? await alice.groups.create("Turns", "mesh") : await alice.groups.create("Turns");
  const link = await alice.groups.enableLink(id);
  for (const p of peers.slice(1)) await p.groups.joinByLink(mode === "mesh" ? link : `https://app.ghostly.tools/#/join/${link}`);
  if (mode === "mesh") await world.until(() => peers.every(p => world.view(p, id)?.members.length === 4 && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000);
  else await world.until(() => peers.every(p => world.member(p, id)), 20 * 60_000);
  await world.run(30_000);
  if (way === "cut") world.cut = (a: Peer, b: Peer) => a === dave || b === dave; else dave.online = false;
  await world.run(60_000);
  const written: string[] = [];
  const talk = async (tag: string) => {
    for (let i = 0; i < 3; i++) { const p = [bob, carol][i % 2]; const text = `${p.name} ${tag}${i + 1}`; written.push(text); await p.groups.send(id, text); await world.run(2_000); }
  };
  await talk("b");
  for (const [i, change] of changes.entries()) {
    if (change === "rename") await alice.groups.rename(id, `Turns ${i + 2}`); else await alice.groups.setPicture(id, PIC);
    written.push(change === "rename" ? "[renamed]" : "[picture]");
    await world.run(5_000);
    await talk(`a${i + 1}.`);
  }
  await world.run(10_000);
  if (way === "cut") world.cut = null; else await world.restart(dave);
  await world.run(4 * 60_000);
  const rows = (p: Peer) => p.messages.filter(m => m.linkId === `group:${id}`).map(m => m.event ? `[${m.event}]` : m.text).filter(t => written.includes(t));
  return { carol: rows(carol), dave: rows(dave), written };
}

describe("a member back from away reads a rename or a new picture where it was made", { timeout: 120_000 }, () => {
  for (const mode of ["mesh", "community"] as const) for (const way of ["cut", "restart"] as const) for (const change of ["rename", "picture"] as const) {
    it(`${mode === "mesh" ? "a private group" : "a community"}, ${way === "cut" ? "network cut" : "app closed"}: the ${change} line between the lines written before and after it`, async () => {
      const { carol, dave, written } = await backFromAway(mode, way, [change]);
      expect(carol).toEqual(written);
      // Not the newest row (and the list's preview), below the lines written after it.
      expect(dave).toEqual(written);
    });
  }
});

describe("a member back from away who missed two changes reads each where it was made", { timeout: 120_000 }, () => {
  for (const mode of ["mesh", "community"] as const) for (const changes of [["rename", "rename"], ["rename", "picture"]] as const) {
    it(`${mode === "mesh" ? "a private group" : "a community"}: a ${changes[0]} then a ${changes[1]}, each line between the lines written before and after it`, async () => {
      const { carol, dave, written } = await backFromAway(mode, "cut", [...changes]);
      expect(carol).toEqual(written);
      // Not the two merged into the latest's line, nor the first one's line missing.
      expect(dave).toEqual(written);
    });
  }
});
