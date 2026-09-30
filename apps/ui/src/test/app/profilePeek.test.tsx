import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeekChat, PeekResult } from "@ghostly/browser/engine/profilePeek";
import { AccountBar } from "../../components/AccountBar";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { useProfilePeek } from "../../hooks/useProfilePeek";
import { createProfile, prefixOf, settingsKeyFor, type ProfileEntry } from "../../lib/profiles";
import { clearPeek, mergePeek, mutedInProfile, nextPeekDelay, peekFresh, peekTargets, startPeekLoop, PEEK_PACE, type PeekTarget } from "../../lib/profilePeek";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: profiles.peek

const notices = vi.hoisted(() => ({ show: vi.fn(async () => {}) }));
vi.mock("../../lib/notifications", async (original) => ({ ...(await original<typeof import("../../lib/notifications")>()), showPrivateNotification: notices.show }));

const chat = (linkId: string, patch: Partial<PeekChat> = {}): PeekChat => ({ linkId, peer: `peer-${linkId}`, peerSequence: 4, text: null, held: 0, ...patch });
const done = (chats: PeekChat[]): PeekResult => ({ status: "done", reads: chats.length, chats });
/** A chat of another profile, as its own chat list keeps it: the contact's link key is what a mute is found by. */
function chatIn(entry: ProfileEntry, id: string, peer: string) {
  localStorage.setItem(`${prefixOf(entry.id)}${id}`, JSON.stringify({ id, mySeedB64: "s", peerPubKeyB64: peer, encKeyB64: "e", createdAt: 0, messages: [] }));
}
function lock(entry: ProfileEntry) {
  localStorage.setItem(settingsKeyFor(entry.id), JSON.stringify({ lockScreen: { enabled: true, passwordHash: "hash", timeout: 5 } }));
}

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  notices.show.mockClear();
  window.history.replaceState(null, "", "#/");
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.useRealTimers();
});

describe("what was seen waiting for another profile", () => {
  it("stays new after its DHT envelope expired, until that profile read the contact again or runs", () => {
    const work = createProfile("Work");
    expect(mergePeek(work.id, done([chat("a", { text: "t1" })]))).toHaveLength(1);
    // The next look finds only a keep-alive: the text is still waiting for Work.
    expect(mergePeek(work.id, done([chat("a")]))).toHaveLength(0);
    expect(peekFresh(work.id)).toBe(1);
    // Items held, in another chat: two chats with something new.
    mergePeek(work.id, done([chat("b", { held: 2 })]));
    expect(peekFresh(work.id)).toBe(2);
    // Work ran meanwhile (in another window): its reading of the contact moved, the text was taken.
    mergePeek(work.id, done([chat("a", { peerSequence: 9 })]));
    expect(peekFresh(work.id)).toBe(1);
    clearPeek(work.id);
    expect(peekFresh(work.id)).toBe(0);
  });

  it("paces the looks: about three minutes with jitter, slower hidden or on battery", () => {
    const base = nextPeekDelay({ hidden: false, onBattery: false, random: () => 0.5 });
    expect(base).toBe(PEEK_PACE.baseMs);
    expect(nextPeekDelay({ hidden: false, onBattery: false, random: () => 0 })).toBe(PEEK_PACE.baseMs * (1 - PEEK_PACE.jitter));
    expect(nextPeekDelay({ hidden: false, onBattery: false, random: () => 1 })).toBeLessThan(5 * 60_000);
    expect(nextPeekDelay({ hidden: true, onBattery: false, random: () => 0.5 })).toBe(base * PEEK_PACE.hiddenFactor);
    expect(nextPeekDelay({ hidden: false, onBattery: true, random: () => 0.5 })).toBe(base * PEEK_PACE.batteryFactor);
  });

  it("looks at every other unlocked profile, stops a round on the relays' budget, and reads nothing turned off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const work = createProfile("Work"), family = createProfile("Family"), club = createProfile("Club");
    lock(club);
    expect((await peekTargets()).map((t) => t.name)).toEqual(["Work", "Family"]);
    expect((await peekTargets())[0].dbName).toBe(`ghostly_${work.id}`);
    let enabled = true;
    const results: Record<string, PeekResult> = { [work.id]: { status: "budget", reads: 1, chats: [] }, [family.id]: done([chat("f", { text: "t" })]) };
    const call = vi.fn(async (target: PeekTarget) => results[target.id]);
    const onFresh = vi.fn();
    const stop = startPeekLoop({ call, targets: peekTargets, enabled: () => enabled, hidden: () => false, onBattery: async () => false, onFresh, random: () => 0.5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.firstMs); });
    // Work's round met the budget: Family waits for the next round.
    expect(call.mock.calls.map(([t]) => t.name)).toEqual(["Work"]);
    results[work.id] = done([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.baseMs); });
    expect(call.mock.calls.map(([t]) => t.name)).toEqual(["Work", "Work", "Family"]);
    expect(onFresh).toHaveBeenCalledOnce();
    expect(onFresh.mock.calls[0][0]).toMatchObject({ id: family.id });
    enabled = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.baseMs * 3); });
    expect(call).toHaveBeenCalledTimes(3);
    stop();
  });

  it("reads another profile's mutes without forgetting its ended ones", () => {
    const work = createProfile("Work");
    chatIn(work, "c1", "peer-1");
    chatIn(work, "c2", "peer-2");
    localStorage.setItem(`${prefixOf(work.id)}mute_c1`, "forever");
    localStorage.setItem(`${prefixOf(work.id)}mute_c2`, String(Date.now() - 1));
    expect(mutedInProfile(work.id, { linkId: "l1", peer: "peer-1" })).toBe(true);
    expect(mutedInProfile(work.id, { linkId: "l2", peer: "peer-2" })).toBe(false);
    // A community group, under its own name.
    localStorage.setItem(`${prefixOf(work.id)}mute_group:g1`, "forever");
    expect(mutedInProfile(work.id, { linkId: "group:g1", peer: "" })).toBe(true);
    expect(mutedInProfile(work.id, { linkId: "group:g2", peer: "" })).toBe(false);
    expect(localStorage.getItem(`${prefixOf(work.id)}mute_c2`), "that profile's storage is not written").not.toBeNull();
  });
});

describe("the switcher's New", () => {
  it("shows New apart from unread, a dot on the picture, and nothing for a locked profile", async () => {
    const work = createProfile("Work"), family = createProfile("Family");
    mergePeek(work.id, done([chat("a", { text: "t" })]));
    mergePeek(family.id, done([chat("b", { held: 1 })]));
    lock(family);
    const { user } = renderApp(<Routes><Route path="*" element={<AccountBar />} /></Routes>);

    expect(await screen.findByTestId("account-profile-others-new")).toBeInTheDocument();
    expect(screen.getByTestId("account-profile-others")).toBeInTheDocument();
    expect(screen.getByTestId("account-profile")).toHaveAccessibleName(/new messages in another profile/);
    await user.click(screen.getByTestId("account-profile"));
    const [workItem, familyItem] = within(screen.getByRole("menu")).getAllByTestId("profile-switcher-item");
    expect(workItem).toHaveAccessibleName("Switch to Work, new messages");
    expect(within(workItem).getByTestId("profile-switcher-new")).toHaveTextContent("New");
    expect(within(workItem).queryByTestId("profile-switcher-unread")).not.toBeInTheDocument();
    expect(familyItem).toHaveAccessibleName("Switch to Family, locked");
    expect(within(familyItem).queryByTestId("profile-switcher-new")).not.toBeInTheDocument();
  });

  it("updates while open when a look finds something", async () => {
    const work = createProfile("Work");
    renderApp(<Routes><Route path="*" element={<AccountBar />} /></Routes>);
    expect(screen.queryByTestId("account-profile-others-new")).not.toBeInTheDocument();
    act(() => { mergePeek(work.id, done([chat("a", { held: 3 })])); });
    expect(await screen.findByTestId("account-profile-others-new")).toBeInTheDocument();
  });
});

function Peeking() { useProfilePeek(); return null; }

describe("the look itself", () => {
  it("asks the peer about the other profile, and notifies only when turned on and not muted there", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const work = createProfile("Work");
    chatIn(work, "c1", "peer-a");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ profilePeek: { enabled: true, notify: true }, notifications: { soundEnabled: true, systemEnabled: true } }));
    let chats = [chat("a", { peer: "peer-a", text: "t1" })];
    fakeEngine.on("peekProfile", () => done(chats));
    renderApp(<Peeking />);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.firstMs); });
    expect(fakeEngine.callsTo("peekProfile")).toEqual([{ profile: work.id, dbName: `ghostly_${work.id}` }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(notices.show).toHaveBeenCalledOnce();
    expect(notices.show.mock.calls[0]).toEqual([expect.stringMatching(/^peek-/), "New message in Work", `profile:${work.id}`]);
    // Muted in Work: new there, but quiet.
    localStorage.setItem(`${prefixOf(work.id)}mute_c1`, "forever");
    clearPeek(work.id);
    chats = [chat("a", { peer: "peer-a", text: "t2" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.baseMs * 2); });
    expect(peekFresh(work.id)).toBe(1);
    expect(notices.show).toHaveBeenCalledOnce();
  });

  it("is off by default on the web, and forgets what was seen for the profile that runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const work = createProfile("Work");
    mergePeek("", done([chat("mine", { text: "t" })]));
    renderApp(<Peeking />);
    expect(peekFresh("")).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEEK_PACE.baseMs * 2); });
    expect(fakeEngine.callsTo("peekProfile")).toEqual([]);
    expect(peekFresh(work.id)).toBe(0);
  });
});

describe("Settings", () => {
  it("has Check other profiles off on the web, and the notice only once it is on", async () => {
    createProfile("Work");
    const { user } = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);
    const toggle = await screen.findByTestId("settings-profile-peek");
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId("settings-profile-peek-notify")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    const notify = screen.getByTestId("settings-profile-peek-notify");
    expect(notify).not.toBeChecked();
    await user.click(notify);
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).profilePeek).toEqual({ enabled: true, notify: true });
  });
});
