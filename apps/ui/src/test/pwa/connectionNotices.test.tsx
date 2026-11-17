import { render, screen, waitFor, within, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { Root } from "../../Root";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import "fake-indexeddb/auto";
import { Route, Routes } from "react-router-dom";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession, deleteSession } from "../../lib/storage";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import { OfflineBanner } from "../../components/OfflineBanner";
import type { GroupEdgeView, GroupMemberView, LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { GroupConnection } from "../../components/GroupConnection";
import { PeerAvatar } from "../../components/Avatar";
import { PeerPresenceLine } from "../../components/PresenceMarks";
import { ChatSubtitle } from "../../components/TypingIndicator";
import { usePeerTyping } from "../../hooks/useTyping";
import { StorageFullBanner } from "../../components/StorageFullBanner";
import type { ChatSession } from "../../lib/types";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

// covers: extension.reconnecting
describe("the reconnecting notice", () => {
  /**
   * An extension tab whose peer went away (the offscreen document restarted) and did not come back at once: the page
   * keeps trying by itself, and says so above the chat list until it is connected again.
   */
  afterEach(async () => {
    fakeEngine.refuse = null;
    await engine.connect();
  });

  it("shows from the first failed try to reach the peer again, and goes once the page is connected", async () => {
    render(<Root />);
    const sidebar = await screen.findByTestId("sidebar");
    expect(screen.queryByTestId("reconnecting-banner")).toBeNull();

    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
    // The first try is half a second later; nothing shows before it failed.
    expect(screen.queryByTestId("reconnecting-banner")).toBeNull();
    const banner = await within(sidebar).findByTestId("reconnecting-banner", {}, { timeout: 3000 });
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("Reconnecting… · This tab lost Ghostly and keeps trying. New messages show here once it's back.");

    fakeEngine.refuse = null;
    await waitFor(() => expect(screen.queryByTestId("reconnecting-banner")).toBeNull(), { timeout: 3000 });
    expect(engine.reconnecting).toBe(false);
  });

  it("says once that the tab is connected again, on a page whose list is hidden too, and nothing before it was lost", async () => {
    // The banner goes with nothing said: a screen-reader user who heard "Reconnecting…" never heard it was over.
    windowIs(true);
    window.location.hash = "#/settings";
    render(<Root />);
    await screen.findByTestId("mobile-tabs");
    const said = screen.getByTestId("reconnected-said");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toBeEmptyDOMElement();

    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
    await waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
    expect(said).toBeEmptyDOMElement();

    fakeEngine.refuse = null;
    await waitFor(() => expect(said).toHaveTextContent("Connected to Ghostly again"), { timeout: 3000 });
    expect(said).toBeVisible();

    // Lost again: the line clears, to be said anew once it is back.
    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
    await waitFor(() => expect(said).toBeEmptyDOMElement(), { timeout: 3000 });
    window.location.hash = "";
  });
});

// covers: extension.reconnecting
describe("reconnecting, in an open chat", () => {
  /**
   * An extension tab that lost its peer, with a chat open on a phone width: the list's "Reconnecting…" is on another
   * screen, and the chat looked live while what was sent stayed in the field. The same sentence shows under the chat's
   * header, as the offline one does. Wider, the list beside the chat has it, and the chat does not say it twice.
   */

  const PEER = "peer".padEnd(52, "p");
  const SENTENCE = "Reconnecting… · This tab lost Ghostly and keeps trying. New messages show here once it's back.";

  afterEach(async () => {
    fakeEngine.refuse = null;
    await engine.connect();
    vi.restoreAllMocks();
  });

  /** The peer goes away and does not come back: the page's tries to reach it fail from the first one on. */
  function losePeer() {
    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
  }

  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  function openGroup() {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1 })] });
    return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  }

  it("on a phone, says it under the chat's header, and goes once the page is connected again", async () => {
    windowIs(true);
    openChat();
    await screen.findByTestId("chat-options");
    expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument();
    losePeer();
    const banner = await screen.findByTestId("chat-reconnecting-banner", {}, { timeout: 3000 });
    expect(banner).toHaveTextContent(SENTENCE);
    expect(banner).toHaveAttribute("role", "status");
    fakeEngine.refuse = null;
    await vi.waitFor(() => expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it("on a phone, in a group too", async () => {
    windowIs(true);
    openGroup();
    losePeer();
    expect(await screen.findByTestId("chat-reconnecting-banner", {}, { timeout: 3000 })).toHaveTextContent(SENTENCE);
  });

  it("wider than a phone, leaves it to the chat list beside the chat", async () => {
    windowIs(false);
    openChat();
    await screen.findByTestId("chat-options");
    losePeer();
    await vi.waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
    expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument();
  });
});

// covers: extension.reconnecting
describe("reconnecting, on a menu page", () => {
  /**
   * An extension tab that lost its peer, on Services, Settings or Profile at a phone width: the chat list (and its
   * "Reconnecting…") is kept mounted but hidden, so the page looked live while nothing it did reached Ghostly. The page
   * says it over itself, in its own words; wider, the list beside it does.
   */

  const SENTENCE = "Reconnecting… · This tab lost Ghostly and keeps trying. Wait until it's back to change anything here.";

  afterEach(async () => {
    fakeEngine.refuse = null;
    await engine.connect();
    window.location.hash = "";
  });

  function losePeer() {
    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
  }

  it.each(["/services", "/settings", "/profile"])("on a phone, %s says it over the page, and it goes once the page is connected again", async (page) => {
    windowIs(true);
    window.location.hash = `#${page}`;
    render(<Root />);
    await screen.findByTestId("mobile-tabs");
    expect(screen.queryByTestId("page-reconnecting-banner")).toBeNull();
    losePeer();
    const banner = await screen.findByTestId("page-reconnecting-banner", {}, { timeout: 3000 });
    expect(banner).toBeVisible();
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(SENTENCE);
    fakeEngine.refuse = null;
    await waitFor(() => expect(screen.queryByTestId("page-reconnecting-banner")).toBeNull(), { timeout: 3000 });
  });

  it("on a phone's chat list, only the list says it", async () => {
    windowIs(true);
    render(<Root />);
    await screen.findByTestId("sidebar");
    losePeer();
    await screen.findByTestId("reconnecting-banner", {}, { timeout: 3000 });
    expect(screen.queryByTestId("page-reconnecting-banner")).toBeNull();
  });

  it("wider than a phone, leaves it to the chat list beside the page", async () => {
    windowIs(false);
    window.location.hash = "#/settings";
    render(<Root />);
    await screen.findByTestId("sidebar");
    losePeer();
    await screen.findByTestId("reconnecting-banner", {}, { timeout: 3000 });
    expect(screen.queryByTestId("page-reconnecting-banner")).toBeNull();
  });
});

// covers: app.pwa.offline
describe("offline", () => {
  /**
   * Offline in an open chat on a phone: the list's notice is on another screen, and the header's icon alone says it only
   * to a screen reader or after a tap. The same sentence shows under the chat's header. Wider, the list beside the chat
   * has it, and the chat does not say it twice.
   */

  const PEER = "peer".padEnd(52, "p");
  const SENTENCE = "Offline · Your chats are here. Nothing goes out until you're back online.";
  afterEach(() => vi.restoreAllMocks());

  const offline = () => vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  function openGroup() {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1 })] });
    return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  }

  describe("offline, in an open chat", () => {
    it("on a phone, says it under the chat's header, in words", async () => {
      windowIs(true);
      offline();
      openChat();
      const banner = await screen.findByTestId("chat-offline-banner");
      expect(banner).toHaveTextContent(SENTENCE);
      expect(banner).toHaveAttribute("role", "status");
    });

    it("on a phone, in a group too", async () => {
      windowIs(true);
      offline();
      openGroup();
      expect(await screen.findByTestId("chat-offline-banner")).toHaveTextContent(SENTENCE);
    });

    it("online, says nothing", async () => {
      windowIs(true);
      openChat();
      await screen.findByTestId("chat-options");
      expect(screen.queryByTestId("chat-offline-banner")).not.toBeInTheDocument();
    });

    it("wider than a phone, leaves it to the chat list beside the chat", async () => {
      windowIs(false);
      offline();
      openChat();
      await screen.findByTestId("chat-options");
      expect(screen.queryByTestId("chat-offline-banner")).not.toBeInTheDocument();
    });
  });

  describe("the chat list's offline notice", () => {
    // At 1280 px the 420 px list cut it to "… Nothing goes out until you're bac…", with no way to read the rest.
    it("wraps its sentence rather than cutting it", () => {
      offline();
      renderApp(<OfflineBanner />);
      const banner = screen.getByTestId("offline-banner");
      expect(banner).toHaveTextContent(SENTENCE);
      for (const el of [banner, ...banner.querySelectorAll("*")]) {
        expect(el.className, el.tagName).not.toMatch(/\b(truncate|whitespace-nowrap|line-clamp-\d|text-ellipsis)\b/);
      }
    });
  });
});

// covers: extension.reconnecting
describe("the header while the tab lost its peer", () => {
  /**
   * An extension tab whose peer went away and did not come back at once (the Reconnecting notice): what the page holds
   * is the last state it was told. The header said "Connected · WebRTC", with the contact's green dot, beside the notice
   * that nothing new arrives; it says the chat is on its way until the peer is back.
   */
  afterEach(async () => {
    fakeEngine.refuse = null;
    await engine.connect();
  });

  const PEER = "peer".padEnd(52, "p");
  type Pairing = NonNullable<LinkView["pairing"]>;

  /** The peer goes and its tries to start again fail, until `back`. */
  async function losePeer() {
    fakeEngine.refuse = new Error("The offscreen document did not start");
    act(() => fakeEngine.drop());
    await waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
  }
  async function back() {
    fakeEngine.refuse = null;
    await waitFor(() => expect(engine.reconnecting).toBe(false), { timeout: 3000 });
  }

  it("says a live chat is connecting, not connected, and its contact's dot goes until the peer is back", async () => {
    const view = renderApp(<div data-testid="header">
      <PeerAvatar peerPubKey={PEER} label="Ana" testId="chat-avatar" presence />
      <PeerPresenceLine peerKey={PEER} testId="chat-presence" />
      <ChatConnection peerKey={PEER} />
    </div>);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", peerPresence: "active", pairing: { status: "ready", transport: "webrtc/1" } as Pairing })] }));
    const trigger = screen.getByTestId("connection-options");
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connected · WebRTC");
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "online");
    expect(screen.getByTestId("chat-presence-presence")).toHaveTextContent("Online");

    await losePeer();
    expect(trigger).toHaveAttribute("data-state", "waiting");
    expect(trigger).not.toHaveAttribute("data-transport");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connecting…");
    expect(screen.getByTestId("connection-state")).toHaveTextContent("Connecting…");
    expect(within(trigger).getByTestId("connection-dot")).toHaveClass("bg-text-muted", "motion-safe:animate-pulse");
    expect(screen.queryByText("Connected · WebRTC")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-avatar-presence")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-presence-presence")).not.toBeInTheDocument();
    // Nothing dials while the peer is gone: no Reconnect to press.
    expect(screen.queryByTestId("connection-reconnect")).not.toBeInTheDocument();

    await back();
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connected · WebRTC");
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "online");
  });

  it("says a failed chat is connecting, not a connection issue", async () => {
    const view = renderApp(<ChatConnection peerKey={PEER} />);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, dataLink: "idle", pairing: { status: "error", error: "Relay refused" } as Pairing })] }));
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-state", "failure");
    await losePeer();
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: Connecting…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a group is connecting, not who is reachable, until the peer is back", async () => {
    const edge: GroupEdgeView = { linkId: "edge-a", state: "open", transport: "webrtc/1", lastSeenAt: Date.now() };
    const members: GroupMemberView[] = [
      { key: "me".padEnd(52, "y"), role: "member", me: true, online: true, missing: 0 },
      { key: "alice".padEnd(52, "y"), nick: "Alice", role: "admin", me: false, online: true, missing: 0, edge },
    ];
    const group = groupView({ status: "active", epoch: 1, members });
    const view = renderApp(<GroupConnection group={group} />);
    act(() => view.engine.update({ groups: [group] }));
    const trigger = screen.getByTestId("group-connection-options");
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("data-transport", "webrtc/1");

    await losePeer();
    expect(trigger).toHaveAttribute("data-state", "waiting");
    expect(trigger).not.toHaveAttribute("data-transport");
    expect(trigger).toHaveAttribute("aria-label", "Group connection: Connecting…");
    expect(within(trigger).getByTestId("group-connection-dot")).toHaveClass("bg-text-muted", "motion-safe:animate-pulse");

    await back();
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Group connection: 1 of 1 reachable");
  });

  // The line under the group's name said "3 members · 2 of 2 reachable" (a community "· your app relays for others")
  // beside the icon's Connecting… (bug hunt, 2026-11-13).
  for (const [kind, patch, said] of [
    ["private group", {}, "3 members · 2 of 2 reachable"],
    ["community hub", { profile: "community", community: { hub: true, hubs: 1, connected: 2 } }, "3 members · your app relays for others"],
  ] as const) it(`says under a ${kind}'s name that it is connecting, not who is reachable`, async () => {
    const member = (key: string, nick: string): GroupMemberView => ({ key: key.padEnd(52, "y"), nick, role: "member", me: false, online: true, missing: 0 });
    const group = groupView({ status: "active", epoch: 1, members: [{ ...member("me", ""), me: true }, member("alice", "Alice"), member("bob", "Bob")], ...patch });
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [group] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(await screen.findByTestId("group-members")).toHaveTextContent(said);

    await losePeer();
    expect(screen.getByTestId("group-members")).toHaveTextContent("3 members · connecting…");
    expect(screen.getByTestId("group-members")).not.toHaveTextContent(said);

    await back();
    expect(screen.getByTestId("group-members")).toHaveTextContent(said);
  });
});

// covers: extension.reconnecting
describe("the contact's typing while the tab lost its peer", () => {
  /**
   * An extension tab whose peer went away and did not come back at once (the Reconnecting notice): the contact's typing is
   * the last thing the tab was told, and the peer that ends it after its timeout is the one gone. The header said
   * "typing…" until the peer was back, however long that took.
   */
  afterEach(async () => {
    fakeEngine.refuse = null;
    await engine.connect();
  });

  const PEER = "peer".padEnd(52, "p");

  async function losePeer() {
    fakeEngine.refuse = new Error("The offscreen document did not start");
    act(() => fakeEngine.drop());
    await waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
  }
  async function back() {
    fakeEngine.refuse = null;
    await waitFor(() => expect(engine.reconnecting).toBe(false), { timeout: 3000 });
  }

  function Typing() {
    return <span data-testid="typing-flag">{String(usePeerTyping(PEER))}</span>;
  }

  it("is not said until the peer is back", async () => {
    const view = renderApp(<div>
      <ChatSubtitle peerKey={PEER} keyLabel="ABCD" />
      <Typing />
    </div>);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", peerTyping: true, peerTypingKind: "recording" })] }));
    expect(screen.getByTestId("chat-typing")).toHaveAttribute("data-kind", "recording");
    expect(screen.getByTestId("typing-flag")).toHaveTextContent("true");

    await losePeer();
    expect(screen.queryByTestId("chat-typing")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-subtitle")).toHaveTextContent("ABCD");
    expect(screen.getByTestId("typing-flag")).toHaveTextContent("false");

    await back();
    expect(screen.getByTestId("chat-typing")).toHaveAttribute("data-kind", "recording");
  });
});

// covers: chat.paired.storage
describe("the storage-full notice", () => {
  /**
   * The page's storage full: a chat's session it refused is kept by the page and shown (lib/storage `unsaved`), but gone at
   * a reload until the engine speaks. The person is told, with what to do about it.
   */
  const session = (messages: ChatSession["messages"]): ChatSession => ({ id: "s1", mySeedB64: "seed", peerPubKeyB64: "peer", encKeyB64: "enc", messages, createdAt: 1 });
  const text = { id: "peer_1", text: "hi", sender: "peer" as const, timestamp: 2 };

  afterEach(() => vi.restoreAllMocks());

  it("shows while a chat's copy could not be stored, with the next step, and goes once it is", async () => {
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();

    const setItem = localStorage.setItem.bind(localStorage);
    const full = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "ghostly_s1") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem(key, value);
    });
    await act(async () => { saveSession(session([text])); });
    expect(screen.getByTestId("storage-full-banner")).toHaveTextContent("Storage full · New messages still show here. To keep them after a reload, delete chats or profiles you no longer need.");

    full.mockRestore();
    await act(async () => { saveSession(session([text, { ...text, id: "peer_2", timestamp: 3 }])); });
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();
  });

  /** localStorage holding at most `quota` characters, keys and values, as a browser's does. */
  function fillTo(quota: number) {
    const setItem = localStorage.setItem.bind(localStorage);
    const used = (except: string) => Object.keys(localStorage).filter((k) => k !== except).reduce((n, k) => n + k.length + (localStorage.getItem(k)?.length ?? 0), 0);
    return vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (used(key) + key.length + value.length > quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem(key, value);
    });
  }
  const long = (id: string, size: number): ChatSession => ({ ...session([{ ...text, id: `peer_${id}`, text: "x".repeat(size) }]), id });

  it("goes once deleting a chat makes room, and the held chat is stored", async () => {
    localStorage.clear();
    saveSession(long("old", 6000));
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    fillTo(7000);
    await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
    expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();

    await act(async () => { deleteSession("old"); });
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();
    expect(localStorage.getItem("ghostly_s1")).toContain("y".repeat(2000));
  });

  it("stays when the delete did not make enough room", async () => {
    localStorage.clear();
    saveSession(long("old", 6000));
    saveSession(long("small", 100));
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    fillTo(7000);
    await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
    await act(async () => { deleteSession("small"); });
    expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();
    expect(localStorage.getItem("ghostly_s1")).not.toContain("y".repeat(2000));
  });

  it("goes once room is made outside this page (another profile's chats deleted), at the storage event or the page's focus", async () => {
    for (const event of [() => new StorageEvent("storage"), () => new FocusEvent("focus")]) {
      localStorage.clear();
      localStorage.setItem("ghostly_other_profile", "z".repeat(6000));
      saveSession(session([]));
      const view = renderApp(<StorageFullBanner />);
      const full = fillTo(7000);
      await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
      expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();

      localStorage.removeItem("ghostly_other_profile");
      await act(async () => { window.dispatchEvent(event()); });
      expect(screen.queryByTestId("storage-full-banner")).toBeNull();
      expect(localStorage.getItem("ghostly_s1")).toContain("y".repeat(2000));
      full.mockRestore();
      view.unmount();
    }
  });
});
