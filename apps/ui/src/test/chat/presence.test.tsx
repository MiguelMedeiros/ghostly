import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatRow, type ChatRowProps } from "../../components/ChatRow";
import { PeerAvatar } from "../../components/Avatar";
import { PeerPresenceLine } from "../../components/PresenceMarks";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { presenceIndex, resetPresenceIndex } from "../../lib/presence";
import { axeViolations } from "../axe";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.status.shown

/*
 * A contact's presence and status (WISP 401 § Presence and status) where their chat is shown: the dot on their picture
 * while they say they are online, and the status they set beside their name, in the chat list, the chat's header and
 * the contact panel. Read once per engine state into one map by key; a row is drawn again only for its own contact.
 */

// One per drawing of a chat's row: the row draws its contact's picture each time.
const draws = vi.hoisted(() => new Map<string, number>());
vi.mock("../../components/Avatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/Avatar")>();
  return { ...actual, PeerAvatar: (props: Parameters<typeof actual.PeerAvatar>[0]) => {
    if (props.testId === "chat-row-avatar" && props.peerPubKey) draws.set(props.peerPubKey, (draws.get(props.peerPubKey) ?? 0) + 1);
    return actual.PeerAvatar(props);
  } };
});

const ANA = "ana".padEnd(52, "a"), BO = "bo".padEnd(52, "b");
const NOW = Date.now();
const HOUR = 3_600_000;
const link = (peer: string, patch: Partial<LinkView> = {}) => linkView({ id: `link-${peer.slice(0, 3)}`, peerPubKeyZ32: peer, profile: "paired-chat/1", ...patch });
const setLinks = (...links: LinkView[]) => act(() => fakeEngine.update({ links }));
const props = (peer = ANA, over: Partial<ChatRowProps> = {}) => ({ chatId: `chat-${peer.slice(0, 3)}`, density: "compact", active: false, label: peer === ANA ? "Ana" : "Bo",
  named: true, keyLabel: "abcdef...uvwxyz", peerPubKey: peer, time: "12:00", unread: 0, pinned: false, syncing: false, creator: false,
  onOpen: () => {}, onTogglePin: () => {}, onDelete: () => {}, deleteLabel: "Delete", ...over }) as ChatRowProps;
const rowOf = (peer: string) => document.querySelector(`[data-chat="chat-${peer.slice(0, 3)}"]`) as HTMLElement;

beforeEach(() => { resetPresenceIndex(); draws.clear(); });
afterEach(() => { vi.useRealTimers(); resetPresenceIndex(); });

describe("the contacts' presence, read from the engine's state", () => {
  it("is built once per state, keeps an unchanged contact's entry, and leaves a status past its end out", () => {
    setLinks(link(ANA, { peerPresence: "active", peerStatus: { emoji: "🍕", text: "At lunch" } }), link(BO, { peerStatus: { text: "Gone", until: NOW - 1 } }), link("c".padEnd(52, "c")));
    const first = presenceIndex();
    expect(presenceIndex()).toBe(first);
    expect([...first.keys()]).toEqual([ANA]);
    expect(first.get(ANA)).toEqual({ presence: "active", status: { emoji: "🍕", text: "At lunch" } });
    // A new state, Ana as she was and Bo now idle: Ana's entry is the same object, so her row is not drawn again.
    setLinks(link(ANA, { peerPresence: "active", peerStatus: { emoji: "🍕", text: "At lunch" } }), link(BO, { peerPresence: "idle" }));
    const second = presenceIndex();
    expect(second).not.toBe(first);
    expect(second.get(ANA)).toBe(first.get(ANA));
    expect(second.get(BO)).toEqual({ presence: "idle" });
  });
});

describe("a chat's row", () => {
  it("online with a status: the dot, the emoji and the text beside the name, and all of it in the row's name", () => {
    setLinks(link(ANA, { peerPresence: "active", peerStatus: { availability: "busy", emoji: "🌴", text: "On holiday" } }));
    renderApp(<ChatRow {...props(ANA, { unread: 2 })} />);
    const dot = screen.getByTestId("chat-row-presence");
    expect(dot).toHaveAttribute("data-tone", "busy");
    expect(dot).toHaveAttribute("title", "Online, busy");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("chat-row-peer-status-emoji")).toHaveTextContent("🌴");
    expect(screen.getByTestId("chat-row-peer-status-text")).toHaveTextContent("On holiday");
    // Not by colour alone: the row's button names it, after the name and before the unread count.
    expect(screen.getByTestId("chat-row-open")).toHaveAccessibleName("Ana, Online, busy, Status: 🌴 On holiday, 2 unread messages");
    // Right after the name, before the identities; it gives way before the name does.
    expect(screen.getByTestId("chat-row-name").nextElementSibling).toBe(screen.getByTestId("chat-row-peer-status"));
    expect(screen.getByTestId("chat-row-peer-status").className).toContain("max-w-[50%]");
  });

  it.each([
    ["active", undefined, "online", "Online"],
    ["idle", undefined, "idle", "Online, idle"],
    ["active", "away", "away", "Online, away"],
    ["idle", "dnd", "dnd", "Online, do not disturb"],
    ["active", "available", "online", "Online"],
  ] as const)("presence %s, availability %s: a %s dot", (presence, availability, tone, words) => {
    setLinks(link(ANA, { peerPresence: presence, ...(availability ? { peerStatus: { availability } } : {}) }));
    renderApp(<ChatRow {...props()} />);
    const dot = screen.getByTestId("chat-row-presence");
    expect(dot).toHaveAttribute("data-tone", tone);
    expect(dot).toHaveAttribute("title", words);
    // Each look has a shape too: a ring when idle, a bar across for Do not disturb.
    expect(dot.className.includes("border-amber-500")).toBe(tone === "idle");
    expect(dot.childElementCount).toBe(tone === "dnd" ? 1 : 0);
    expect(screen.getByTestId("chat-row-open")).toHaveAccessibleName(new RegExp(`^Ana, ${words}`));
  });

  it("a status with no text says its availability; \"available\" alone says nothing", () => {
    setLinks(link(ANA, { peerStatus: { availability: "dnd" } }));
    const { unmount } = renderApp(<ChatRow {...props()} />);
    expect(screen.getByTestId("chat-row-peer-status-text")).toHaveTextContent("Do not disturb");
    unmount();
    setLinks(link(ANA, { peerStatus: { availability: "available" } }));
    renderApp(<ChatRow {...props()} />);
    expect(screen.queryByTestId("chat-row-peer-status")).toBeNull();
  });

  it("offline with a status: the status, no dot; nothing at all when the contact says nothing or does not share it", () => {
    setLinks(link(ANA, { peerStatus: { emoji: "🏖️" } }), link(BO));
    renderApp(<><ChatRow {...props(ANA)} /><ChatRow {...props(BO)} /></>);
    expect(within(rowOf(ANA)).queryByTestId("chat-row-presence")).toBeNull();
    expect(within(rowOf(ANA)).getByTestId("chat-row-peer-status")).toHaveTextContent("🏖️");
    expect(within(rowOf(ANA)).getByTestId("chat-row-open")).toHaveAccessibleName("Ana, Status: 🏖️");
    // Bo shares no presence (no `p`) and set no status: nothing shows, nothing is said.
    expect(within(rowOf(BO)).queryByTestId("chat-row-presence")).toBeNull();
    expect(within(rowOf(BO)).queryByTestId("chat-row-peer-status")).toBeNull();
    expect(within(rowOf(BO)).getByTestId("chat-row-open")).toHaveAccessibleName("Bo");
  });

  it("a status past its end is not shown, and one that ends goes at its end, with no new state", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
    setLinks(link(ANA, { peerStatus: { text: "Back at 3", until: NOW - 1 } }), link(BO, { peerPresence: "active", peerStatus: { emoji: "🍕", text: "At lunch", until: NOW + HOUR } }));
    renderApp(<><ChatRow {...props(ANA)} /><ChatRow {...props(BO)} /></>);
    expect(within(rowOf(ANA)).queryByTestId("chat-row-peer-status")).toBeNull();
    expect(within(rowOf(BO)).getByTestId("chat-row-peer-status")).toHaveTextContent("At lunch");
    act(() => { vi.advanceTimersByTime(HOUR - 1_000); });
    expect(within(rowOf(BO)).getByTestId("chat-row-peer-status")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_001); });
    expect(within(rowOf(BO)).queryByTestId("chat-row-peer-status")).toBeNull();
    // Still online: the dot stays, the status is gone.
    expect(within(rowOf(BO)).getByTestId("chat-row-presence")).toHaveAttribute("data-tone", "online");
  });

  it("one timer for every contact's end, not one per row", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const peers = Array.from({ length: 20 }, (_, i) => `p${i}`.padEnd(52, "x"));
    setLinks(...peers.map((peer, i) => linkView({ id: `l${i}`, peerPubKeyZ32: peer, peerStatus: { text: `S${i}`, until: NOW + (i + 1) * HOUR } })));
    renderApp(<>{peers.map((peer, i) => <ChatRow key={peer} {...props(peer, { chatId: `c${i}` })} />)}</>);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a contact's presence changing draws their row alone", () => {
    setLinks(link(ANA), link(BO));
    renderApp(<><ChatRow {...props(ANA)} /><ChatRow {...props(BO)} /></>);
    draws.clear();
    for (let i = 0; i < 10; i++) {
      setLinks(link(ANA), link(BO, { peerPresence: i % 2 ? "idle" : "active", lastSyncAt: i }));
    }
    expect(draws.get(ANA)).toBeUndefined();
    expect(draws.get(BO)).toBe(10);
    // States that change nothing either shows draw neither.
    draws.clear();
    for (let i = 0; i < 10; i++) setLinks(link(ANA, { lastSyncAt: i }), link(BO, { peerPresence: "idle", lastSyncAt: i }));
    expect(draws.size).toBe(0);
  });

  it("in Arabic: the dot's words and the status in their own direction", () => {
    setLinks(link(ANA, { peerPresence: "active", peerStatus: { emoji: "🌴", text: "On holiday" } }));
    renderApp(<ChatRow {...props()} />, { language: "ar" });
    const text = screen.getByTestId("chat-row-peer-status-text");
    expect(text.tagName).toBe("BDI");
    expect(text).toHaveAttribute("dir", "auto");
    expect(screen.getByTestId("chat-row-presence")).toHaveAttribute("title", "متصل");
    const name = screen.getByTestId("chat-row-open").getAttribute("aria-label")!;
    expect(name.startsWith("Ana")).toBe(true);
    expect(name).toContain("متصل");
    expect(name).toContain("الحالة: 🌴 On holiday");
  });

  it("has no axe violations", async () => {
    setLinks(link(ANA, { peerPresence: "idle", peerStatus: { availability: "dnd", emoji: "🌙", text: "Asleep" } }));
    renderApp(<ChatRow {...props()} />);
    expect(await axeViolations(rowOf(ANA))).toEqual([]);
  });
});

describe("the chat's header and the contact panel", () => {
  it("the picture's dot, and beside the name the dot's words for a screen reader and the status", async () => {
    setLinks(link(ANA, { peerPresence: "active", peerStatus: { emoji: "🌴", text: "On holiday" } }));
    renderApp(<div data-testid="header">
      <div className="relative"><PeerAvatar peerPubKey={ANA} label="Ana" testId="chat-avatar" presence /></div>
      <PeerPresenceLine peerKey={ANA} testId="chat-presence" />
    </div>);
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "online");
    expect(screen.getByTestId("chat-presence-presence")).toHaveTextContent("Online");
    expect(screen.getByTestId("chat-presence-presence").className).toContain("sr-only");
    expect(screen.getByTestId("chat-presence-status")).toHaveTextContent("🌴On holiday");
    expect(screen.getByTestId("chat-presence-status-text").tagName).toBe("BDI");
    expect(await axeViolations(screen.getByTestId("header"))).toEqual([]);
    // The contact goes away and comes back with nothing to say: nothing shows.
    setLinks(link(ANA));
    expect(screen.queryByTestId("chat-avatar-presence")).toBeNull();
    expect(screen.queryByTestId("chat-presence")).toBeNull();
  });

  it("no dot without `presence`: other places that draw a contact's picture are left as they were", () => {
    setLinks(link(ANA, { peerPresence: "active" }));
    renderApp(<PeerAvatar peerPubKey={ANA} label="Ana" testId="lock-call-avatar" />);
    expect(screen.queryByTestId("lock-call-avatar-presence")).toBeNull();
  });

  it("the contact panel: the dot on their picture and the status under their name", async () => {
    setLinks(link(ANA, { id: "link-1", peerPresence: "idle", peerStatus: { availability: "away", text: "Back soon" } }));
    renderApp(<ContactIdentitiesPanel peerKey={ANA} name="Ana" onClose={() => {}} />);
    expect(screen.getByTestId("chat-identities-picture-presence")).toHaveAttribute("data-tone", "away");
    expect(screen.getByTestId("chat-identities-presence-presence")).toHaveTextContent("Online, away");
    expect(screen.getByTestId("chat-identities-presence-status-text")).toHaveTextContent("Back soon");
    expect(await axeViolations(screen.getByTestId("chat-identities-presence"))).toEqual([]);
  });
});
