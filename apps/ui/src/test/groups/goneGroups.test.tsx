import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GONE_AFTER_MS, useGoneGroups } from "../../hooks/useGoneGroups";
import { createFolder, folderOf, setChatFolder } from "../../lib/chatFolders";
import { groupChat, mutedUntil, setChatMute } from "../../lib/chatMute";
import { groupReadAt, markGroupRead } from "../../lib/groups";
import { createProfile, registryKey, setRunningProfile } from "../../lib/profiles";
import { getSessionDraft, setSessionDraft, setStorageProfile } from "../../lib/storage";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.forget, groups.invite

function Probe() {
  useGoneGroups();
  return null;
}

/** What this device keeps beside a group: a draft, a read mark, a mute and a folder. */
function keep(groupId: string) {
  setSessionDraft(`group:${groupId}`, "half a sentence");
  markGroupRead(groupId, 1234);
  setChatMute(groupChat(groupId), "forever");
  setChatFolder(groupChat(groupId), createFolder("Work")!.id);
}
const kept = (groupId: string) => ({
  draft: getSessionDraft(`group:${groupId}`),
  read: groupReadAt(groupId),
  muted: mutedUntil(groupChat(groupId)),
  filed: !!folderOf(groupChat(groupId)),
});
const all = { draft: "half a sentence", read: 1234, muted: "forever", filed: true };
const none = { draft: "", read: 0, muted: undefined, filed: false };

/** The engine's next state, and the wait after which a group missing from it counts as gone. */
function next(patch: Parameters<typeof fakeEngine.update>[0]) {
  act(() => fakeEngine.update(patch));
  act(() => { vi.advanceTimersByTime(GONE_AFTER_MS); });
}

describe("A group gone from the engine's list takes what this device kept for it", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it("forgets the draft, read mark, mute and folder of a group the engine dropped, and keeps those of one still listed", () => {
    keep("gone"); keep("stays");
    fakeEngine.update({ groups: [groupView({ id: "gone" }), groupView({ id: "stays" })] });
    renderApp(<Probe />);
    next({ groups: [groupView({ id: "stays" })] });
    expect(kept("gone")).toEqual(none);
    expect(kept("stays")).toEqual(all);
  });

  it("keeps everything of a removed group invited again whose invitation was declined: the group stays", () => {
    keep("group-1");
    const invited = groupView({ id: "group-1", canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: "a".padEnd(52, "y"), members: 3, accepted: false } });
    fakeEngine.update({ groups: [invited] });
    renderApp(<Probe />);
    // Declined: the group I was removed from comes back as it was, under the same id.
    next({ groups: [groupView({ id: "group-1", canSend: false, status: "removed" })] });
    expect(kept("group-1")).toEqual(all);
  });

  it("keeps a group missing for a moment only, as the engine swaps its row", () => {
    keep("group-1");
    fakeEngine.update({ groups: [groupView({ id: "group-1" })] });
    renderApp(<Probe />);
    act(() => fakeEngine.update({ groups: [] }));
    act(() => { vi.advanceTimersByTime(GONE_AFTER_MS / 2); });
    act(() => fakeEngine.update({ groups: [groupView({ id: "group-1" })] }));
    act(() => { vi.advanceTimersByTime(GONE_AFTER_MS); });
    expect(kept("group-1")).toEqual(all);
  });

  it("keeps everything while the engine starts again and has not loaded its groups yet", () => {
    keep("group-1");
    fakeEngine.update({ groups: [groupView({ id: "group-1" })] });
    renderApp(<Probe />);
    next({ groups: [], groupsLoaded: undefined });
    next({ groups: [groupView({ id: "group-1" })], groupsLoaded: true });
    expect(kept("group-1")).toEqual(all);
  });

  it("keeps this profile's groups when another page switched the extension's peer to another profile", () => {
    keep("group-1");
    fakeEngine.update({ groups: [groupView({ id: "group-1" })] });
    setRunningProfile("");
    try {
      renderApp(<Probe />);
      // Another page chose another profile: the peer starts again on its groups, which this one never had.
      const work = createProfile("Work");
      localStorage.setItem(registryKey(), JSON.stringify({ ...JSON.parse(localStorage.getItem(registryKey())!), active: work.id }));
      next({ groups: [groupView({ id: "work-group" })] });
      expect(kept("group-1")).toEqual(all);
    } finally { setRunningProfile(undefined); }
  });

  it("forgets only under the profile it saw the group in", () => {
    keep("group-1");
    fakeEngine.update({ groups: [groupView({ id: "group-1" })] });
    renderApp(<Probe />);
    setStorageProfile("work12345a");
    try {
      next({ groups: [] });
    } finally { setStorageProfile(""); }
    expect(kept("group-1")).toEqual(all);
  });
});
