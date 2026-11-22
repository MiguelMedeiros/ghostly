import { describe, expect, it } from "vitest";
import { GroupSession } from "../src/groupSession";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.connection

/*
 * WISP 902 § Transports (revision 2026-11-04): the edge each member keeps while a private group is not on screen is
 * computed from the roster in the order its members were admitted, so every member must read the same order from the
 * chain, a newcomer from its welcome included.
 */

describe("GroupSession.admissionOrder (ghostly-agents#1509)", { timeout: 60_000 }, () => {
  it("is the order the members were admitted in, the creator first, the same on every member and not the roster's key order", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const others: GroupSession[] = [];
    for (const name of ["Bob", "Carol", "Dave", "Erin", "Frank"]) others.push(await admit(mesh, alice, name));
    const expected = [alice, ...others].map(s => s.myKey);
    for (const session of [alice, ...others]) expect(session.admissionOrder).toEqual(expected);
    // The roster itself is sorted by key: the order is the chain's, not that.
    expect(alice.roster.map(([key]) => key)).toEqual([...expected].sort());
  });

  it("drops a member who left, and puts the next one admitted last", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol"), dave = await admit(mesh, alice, "Dave");
    await alice.remove(carol.myKey); await mesh.settle();
    expect(alice.admissionOrder).toEqual([alice.myKey, bob.myKey, dave.myKey]);
    expect(bob.admissionOrder).toEqual(alice.admissionOrder);
    const erin = await admit(mesh, alice, "Erin");
    for (const session of [alice, bob, dave, erin]) expect(session.admissionOrder).toEqual([alice.myKey, bob.myKey, dave.myKey, erin.myKey]);
  });
});
