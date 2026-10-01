import { screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatInvite, encodeCommunityLink, encodeGroupEntryLink, inviteLink, randomBytes, toBase64Url, toZ32 } from "@ghostly/core";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import { MessageBubble } from "../../components/MessageBubble";
import { ensureSession, listSessions } from "../../lib/storage";
import { groupView, linkView } from "../fakeEngine";
import { receivedView } from "../identities/views";
import { renderApp } from "../render";

// covers: chat.cards.invite, chat.cards.group, chat.cards.nostr, chat.cards.identity, invite.own, invite.rejoin

const hex = () => Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("");
const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

/** A message from the contact Alice (or from this profile, `mine`), rendered in a chat with her. */
function bubble(text: string, { mine = false } = {}) {
  return renderApp(<>
    <MessageBubble message={{ id: "m1", text, sender: mine ? "me" : "peer", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />
    <Where />
  </>);
}

describe("invite cards", () => {
  it("a contact's invite shows who sent it, joins only on a tap, and opens the new chat", async () => {
    const { inviteCode } = createChatInvite();
    const { user } = bubble(`Here: ${inviteLink(inviteCode)} see you`);
    const card = screen.getByTestId("entity-invite");
    expect(card).toHaveTextContent("From ~Alice");
    // The text stays as it was, link and all.
    expect(screen.getByTestId("message-text")).toHaveTextContent(`Here: ${inviteLink(inviteCode)} see you`);
    expect(listSessions()).toHaveLength(0);
    await user.click(within(card).getByTestId("entity-invite-join"));
    const [session] = listSessions();
    expect(session).toBeDefined();
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${session.id}`);
    // Joined now: the card opens that chat rather than offering a second one.
    await waitFor(() => expect(card).toHaveAttribute("data-outcome", "joined"));
    expect(within(card).queryByTestId("entity-invite-join")).toBeNull();
  });

  it("refuses this profile's own invite, and offers the chat that owns it", async () => {
    const { mine, inviteCode } = createChatInvite();
    const own = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1" });
    const { user } = bubble(inviteCode, { mine: true });
    const card = screen.getByTestId("entity-invite");
    expect(card).toHaveAttribute("data-outcome", "own");
    expect(card).toHaveTextContent("You sent this");
    expect(within(card).getByTestId("entity-invite-own")).toHaveTextContent("This is your own invite");
    expect(within(card).queryByTestId("entity-invite-join")).toBeNull();
    await user.click(within(card).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${own}`);
    expect(listSessions()).toHaveLength(1);
  });

  it("opens the chat an invite already joined, with no second one", async () => {
    const { invite, inviteCode } = createChatInvite();
    const joined = ensureSession({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64, profile: "paired-chat/1" });
    const { user } = bubble(inviteCode);
    await user.click(within(screen.getByTestId("entity-invite")).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${joined}`);
    expect(listSessions()).toHaveLength(1);
  });

  it("shows no card for a code with a typo", () => {
    const { inviteCode } = createChatInvite();
    bubble(`${inviteCode.slice(0, -1)}${inviteCode.endsWith("q") ? "p" : "q"}`);
    expect(screen.queryByTestId("entity-cards")).toBeNull();
  });
});

describe("group cards", () => {
  const g = toBase64Url(randomBytes(16)), host = toZ32(randomBytes(32));

  it("joins through the link on a tap, and opens the group", async () => {
    const link = encodeGroupEntryLink({ g, host });
    const { user, engine } = bubble(`join us https://app.ghostly.tools/#/join/${link}`);
    engine.on("joinGroupByLink", () => ({ groupId: g }));
    const card = screen.getByTestId("entity-group");
    expect(card).toHaveTextContent("Group invite");
    expect(engine.callsTo("joinGroupByLink")).toEqual([]);
    await user.click(within(card).getByTestId("entity-group-join"));
    expect(engine.callsTo("joinGroupByLink")).toEqual([{ link }]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`));
  });

  it("says why a join failed", async () => {
    const { user, engine } = bubble(encodeCommunityLink({ g, host }));
    engine.on("joinGroupByLink", () => { throw new Error("This group's link was turned off"); });
    expect(screen.getByTestId("entity-group")).toHaveTextContent("Community group");
    await user.click(screen.getByTestId("entity-group-join"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This group's link was turned off");
  });

  it("opens a group this profile is already in", async () => {
    const { user, engine } = bubble(encodeGroupEntryLink({ g, host }));
    engine.update({ groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    const card = await screen.findByText("Book club");
    await user.click(within(card.closest("[data-entity-card]") as HTMLElement).getByTestId("entity-group-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`);
    expect(engine.callsTo("joinGroupByLink")).toEqual([]);
  });
});

describe("Nostr cards", () => {
  it("names the person's relays, asks nothing before the tap, then shows the profile", async () => {
    const pubkey = hex();
    const { user, engine } = bubble(`follow nostr:${npubEncode(pubkey)}`);
    engine.update({ nostr: { own: [], settings: { relays: ["wss://relay.one.example", "wss://relay.two.example"], autoLoadProfiles: false, publish: false } } });
    engine.on("nostrLookup", () => ({ fetchedAt: Math.floor(Date.now() / 1000), relays: ["wss://relay.one.example"], found: true, profile: { name: "Alice in Chains", handle: "alice", about: "Just here for the ghosts.", hasPicture: false, eventAt: 0, eventId: "e" } }));
    const card = screen.getByTestId("entity-nostr");
    await waitFor(() => expect(within(card).getByTestId("entity-nostr-where")).toHaveTextContent("relay.one.example, relay.two.example"));
    expect(engine.callsTo("nostrLookup")).toEqual([]);
    await user.click(within(card).getByTestId("entity-nostr-load"));
    expect(engine.callsTo("nostrLookup")).toEqual([{ type: "profile", pubkey }]);
    expect(await within(card).findByText("Alice in Chains")).toBeVisible();
    expect(within(card).getByTestId("entity-nostr-about")).toHaveTextContent("Just here for the ghosts.");
    expect(within(card).getByTestId("entity-nostr-source")).toHaveTextContent("From relay.one.example");
  });

  it("looks a note up by id and author, never by the code's relay hints, and hides what the mute list hides", async () => {
    const id = hex(), author = hex();
    const { user, engine } = bubble(neventEncode({ id, author, relays: ["wss://somebody-elses.example"] }));
    engine.on("nostrLookup", () => ({ fetchedAt: 0, relays: ["wss://relay.one.example"], found: true, note: { id, author, createdAt: 0, reply: false, content: "", muted: true } }));
    const card = screen.getByTestId("entity-nostr");
    expect(card).toHaveTextContent("The relays this code names are not asked.");
    await user.click(within(card).getByTestId("entity-nostr-load"));
    expect(engine.callsTo("nostrLookup")).toEqual([{ type: "note", id, author }]);
    expect(await within(card).findByTestId("entity-nostr-muted")).toBeVisible();
  });

  it("says when the relays could not be asked", async () => {
    const { user, engine } = bubble(npubEncode(hex()));
    engine.on("nostrLookup", () => { throw new Error("Offline: turn the network on first"); });
    await user.click(screen.getByTestId("entity-nostr-load"));
    expect(await screen.findByTestId("entity-nostr-error")).toHaveTextContent("Offline");
  });
});

describe("identity cards", () => {
  beforeEach(() => {
    // happy-dom never scrolls: every card is in view.
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private fire: IntersectionObserverCallback) {}
      observe() { queueMicrotask(() => this.fire([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a did:key on this device once visible, and says no contact proved it", async () => {
    bubble(`my DID: ${DID_KEY}.`);
    const card = screen.getByTestId("entity-identity");
    expect(card).toHaveAttribute("data-provider", "did");
    expect(within(card).getByTestId("entity-identity-badge")).toHaveTextContent("Not proved in your chats");
    expect(await within(card).findByTestId("entity-identity-facts")).toHaveTextContent("did:key, the key is the identifier");
    expect(card).toHaveTextContent("Checked on this device");
  });

  it("carries the badge of the contact who proved it", async () => {
    const { engine } = bubble(DID_KEY);
    engine.update({ links: [linkView({ peerPubKeyZ32: "peer", identities: { support: true, shared: [], received: [receivedView({ provider: "did", subject: DID_KEY })] } })] });
    ensureSession({ seedB64: "s", peerPubKeyB64: "peer", encKeyB64: "k" });
    await waitFor(() => expect(screen.getByTestId("entity-identity")).toHaveAttribute("data-standing", "verified"));
    expect(screen.getByTestId("entity-identity-badge")).toHaveTextContent("Proved by");
  });

  it("marks this profile's own Ghostly DID", async () => {
    const dht = `did:dht:${toZ32(randomBytes(32))}`;
    const { engine } = bubble(dht, { mine: true });
    engine.update({ did: { id: dht } as never });
    await waitFor(() => expect(screen.getByTestId("entity-identity-badge")).toHaveTextContent("Your Ghostly DID"));
  });

  it("asks nothing for a Pubky key until the tap, and then only the Pkarr relays", async () => {
    const key = toZ32(randomBytes(32));
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => { asked.push(String(input)); throw new TypeError("offline in tests"); });
    const { user } = bubble(`pubky://${key}`);
    const card = screen.getByTestId("entity-identity");
    expect(card).toHaveTextContent("pkarr.pubky.org");
    await Promise.resolve();
    expect(asked).toEqual([]);
    await user.click(within(card).getByTestId("entity-identity-resolve"));
    expect(await within(card).findByTestId("entity-identity-error")).toHaveTextContent("Could not resolve it");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(url => /^https:\/\/pkarr\.pubky\.(org|app)\//.test(url))).toBe(true);
  });
});
