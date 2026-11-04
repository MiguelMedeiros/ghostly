import { act, render, screen, waitFor } from "@testing-library/react";
import { createIdentity, encodeCommunityLink, encodeGroupEntryLink } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { LINK_GROUPS_WAITING } from "../../lib/groups";
import { fakeEngine, groupView } from "../fakeEngine";

// covers: groups.link.join

/*
 * A group's link opened in the app joins with no act of the person's: a page can send the browser to one. So only a few
 * groups joined by links may wait to be let in at once, as for invite links. Past that a link joins nothing and says
 * so, until one of them is let in or deleted. A link to a group already here still goes to the engine.
 */

afterEach(() => { window.location.hash = ""; });

const id = (n: number) => `Group${String(n).padStart(17, "0")}`;
const waiting = (n: number) => groupView({ id: id(n), name: "", invitation: { linkId: `entry-${n}`, contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocked" } });

/** The address is given another group's link while the app is open. */
async function follow(link: string): Promise<void> {
  window.location.hash = `#/join/${link}`;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).not.toContain(link));
}

it("a group's link joins only while few groups joined by links wait to be let in", async () => {
  fakeEngine.on("joinGroupByLink", ({ link }) => ({ groupId: link.split("/")[1] }));
  fakeEngine.update({ groups: Array.from({ length: LINK_GROUPS_WAITING }, (_, n) => waiting(n)) });
  window.location.hash = `#/join/${encodeGroupEntryLink({ g: id(LINK_GROUPS_WAITING), host: createIdentity().pubKeyZ32 })}`;
  render(<Root />);

  // A new group's link past the limit: the engine is never asked, and the app says why and what to do.
  await screen.findByTestId("group-link-invalid");
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
  expect(screen.getByTestId("group-link-invalid-next")).toHaveTextContent("Delete a group that is still waiting to be let in, or paste the link in Join.");
  await follow(encodeCommunityLink({ g: id(LINK_GROUPS_WAITING + 1), host: createIdentity().pubKeyZ32 }));
  expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(0);

  // A link to a group still waiting goes to the engine (it knocks again).
  await follow(encodeGroupEntryLink({ g: id(0), host: createIdentity().pubKeyZ32 }));
  await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(1));

  // One of them is let in: a new link joins again. A group knocking to get back in (it has a status) is not counted.
  act(() => fakeEngine.update({ groups: [{ ...waiting(0), status: "active" }, waiting(1), { ...waiting(2), status: "removed" }] }));
  const next = encodeGroupEntryLink({ g: id(9), host: createIdentity().pubKeyZ32 });
  await follow(next);
  await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink").map((c) => c.link)).toContain(next));
}, 60_000);

it("a link that comes before the engine has loaded its groups waits for them, then counts them", async () => {
  fakeEngine.on("joinGroupByLink", ({ link }) => ({ groupId: link.split("/")[1] }));
  fakeEngine.update({ groupsLoaded: undefined, groups: [] });
  window.location.hash = `#/join/${encodeGroupEntryLink({ g: id(7), host: createIdentity().pubKeyZ32 })}`;
  render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(0);
  act(() => fakeEngine.update({ groupsLoaded: true, groups: Array.from({ length: LINK_GROUPS_WAITING }, (_, n) => waiting(n)) }));
  expect(await screen.findByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
  expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(0);
});
