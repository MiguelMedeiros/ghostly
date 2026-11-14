import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { profileSummary } from "../../lib/profileData";
import { namespaceOf, registerProfile } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
// covers: profiles.delete

/*
 * The chats a profile holds are its groups too, as the chat list shows them: the Delete-profile summary and the Profile
 * page's Chats row counted only the one-to-one chats, so a profile with only groups said "0 chats", and deleting it
 * took its groups and their history all the same.
 */

const OTHER = "abcdefghij";

/** OTHER's peer database with `groups` group records in it, as the engine stores them (keyed by id). */
async function withGroups(groups: number): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(`ghostly_${namespaceOf(OTHER)}`, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("settings"); r.result.createObjectStore("groups", { keyPath: "id" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("groups", "readwrite");
    for (let i = 0; i < groups; i++) tx.objectStore("groups").put({ id: `g${i}` });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

beforeEach(async () => {
  localStorage.clear();
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
});

describe("a profile's chats counted with its groups", () => {
  it("the Delete-profile summary counts another profile's groups", async () => {
    registerProfile(OTHER, "Other");
    await withGroups(2);
    expect((await profileSummary(OTHER)).chats).toBe(2);
  });

  it("the Profile page's Chats row counts this profile's groups", () => {
    fakeEngine.setState({ groups: [groupView({ id: "g1" }), groupView({ id: "g2" })] });
    renderApp(<Profile />);
    expect(screen.getByText(/2 chats/)).toBeInTheDocument();
  });
});
