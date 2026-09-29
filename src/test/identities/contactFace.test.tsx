import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, PublicProfileView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityStack } from "../../components/identities/ContactMarks";
import {
  cleanFaceName, contactFace, faceCandidates, faceChoice, setFaceChoice, shownContactName, suggestedFace, withContactFaces,
} from "../../components/identities/contactFace";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { deleteSession, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { GroupChat } from "../../pages/GroupChat";
import { choose, optionsOf } from "../select";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";

// covers: proofs.badges, proofs.contact-face

const AVATAR = "data:image/jpeg;base64,/9j/2Q==";
const PEER = "p".repeat(52);
const PUBKY_KEY = "y".repeat(52);
const NOSTR_KEY = "a".repeat(64);
const profile = (patch: Partial<PublicProfileView> = {}): PublicProfileView => ({
  found: true, name: "Alice Liddell", handle: "@alice", avatar: AVATAR, hosts: ["nexus.pubky.app"], fetchedAt: now() - 3600, ...patch,
});
const pubky = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({
  id: "pubky-1", provider: "pubky", subject: PUBKY_KEY, verified: { subject: PUBKY_KEY, source: "File on the homeserver" }, publicProfile: profile(), ...patch,
});
const nostr = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({
  id: "nostr-1", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" },
  publicProfile: profile({ name: "Alice on Nostr", hosts: ["relay.damus.io"] }), ...patch,
});
const withReceived = (received: ReceivedIdentityView[]) => ({ links: [linkView({ peerPubKeyZ32: PEER, identities: identitiesView({ received }) })] });
const chat = (patch: Partial<ChatSession> = {}): ChatSession =>
  ({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: PEER, encKeyB64: "enc", messages: [], createdAt: Date.now(), nick: "Ghost Bob", nickSource: "profile", ...patch });
const choosePubky = () => setFaceChoice(PEER, { provider: "pubky", subject: PUBKY_KEY });

/** Where the app is: nothing about the marks' card opens the chat. */
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
function list(received: ReceivedIdentityView[]) {
  fakeEngine.on("loadPublicProfile", () => undefined);
  const shown = renderApp(<UpdateProvider><Sidebar /><Where /></UpdateProvider>);
  act(() => fakeEngine.update(withReceived(received)));
  return shown;
}
const row = () => screen.getByTestId("chat-row");

describe("a contact's name, by precedence", () => {
  const face = { id: "x", provider: "pubky", subject: PUBKY_KEY, providerName: "Pubky", name: "Alice Liddell" };
  it("is the nickname given here, then the chosen identity's name, then their own, then their key", () => {
    expect(shownContactName({ nickname: "Mom", face, nick: "Ghost", fallback: "Contact · abc" })).toEqual({ name: "Mom", from: "nickname" });
    expect(shownContactName({ face, nick: "Ghost", fallback: "Contact · abc" })).toEqual({ name: "Alice Liddell", from: "identity" });
    expect(shownContactName({ face: { ...face, name: undefined }, nick: "Ghost", fallback: "Contact · abc" })).toEqual({ name: "Ghost", from: "contact" });
    expect(shownContactName({ fallback: "Contact · abc" })).toEqual({ name: "Contact · abc", from: "key" });
  });

  it("cleans a profile's name: no controls, bidi or invisible marks, one line, at most 64 characters", () => {
    expect(cleanFaceName("A\u202Eecil\u202C\u200F\u2066x\u2069\n\tB")).toBe("Aecilx B");
    expect(cleanFaceName("\u200B \u0000")).toBeUndefined();
    expect(Array.from(cleanFaceName("\u{1F600}".repeat(80))!)).toHaveLength(64);
  });
});

describe("which identity a contact can be shown as", () => {
  const t = now();
  it("only a verified one with a public profile that has a name or a photo", () => {
    expect(faceCandidates([pubky(), nostr()], t).map(f => f.name)).toEqual(["Alice Liddell", "Alice on Nostr"]);
    expect(faceCandidates([pubky({ publicProfile: profile({ found: false }) })], t)).toEqual([]);
    expect(faceCandidates([pubky({ publicProfile: profile({ name: undefined, avatar: undefined }) })], t)).toEqual([]);
    // A photo alone is enough; a remote address never is.
    expect(faceCandidates([pubky({ publicProfile: profile({ name: undefined }) })], t)[0]).toMatchObject({ photo: AVATAR });
    expect(faceCandidates([pubky({ publicProfile: profile({ avatar: "https://evil.example/a.png" }) })], t)[0].photo).toBeUndefined();
    // A domain has no public profile reader.
    expect(faceCandidates([receivedView({ publicProfile: profile() })], t)).toEqual([]);
  });

  it("falls back at once when the chosen proof expires, is revoked, withdrawn, fails, or was made with another key", () => {
    const choice = { provider: "pubky", subject: PUBKY_KEY };
    expect(contactFace([pubky()], choice, t)?.name).toBe("Alice Liddell");
    expect(contactFace([pubky({ verifiedAt: t - 80 * DAY, expiresAt: t + DAY })], choice, t)?.name).toBe("Alice Liddell");
    for (const patch of [{ expiresAt: t - 1 }, { status: "revoked" as const }, { status: "withdrawn" as const }, { status: "unconfirmed" as const }, { status: "previous-key" as const }])
      expect(contactFace([pubky(patch)], choice, t)).toBeUndefined();
    // Another Pubky key is another identity.
    expect(contactFace([pubky({ subject: "z".repeat(52) })], choice, t)).toBeUndefined();
    expect(contactFace([pubky()], "none", t)).toBeUndefined();
  });

  it("offers the only one, while nothing was chosen and no nickname was given", () => {
    expect(suggestedFace([pubky()], undefined, undefined)?.provider).toBe("pubky");
    expect(suggestedFace([pubky()], "none", undefined)).toBeUndefined();
    expect(suggestedFace([pubky()], undefined, "Mom")).toBeUndefined();
    expect(suggestedFace([pubky(), nostr()], undefined, undefined)).toBeUndefined();
  });

  it("is kept per contact on this device, and goes with the contact's last chat", () => {
    saveSession(chat());
    saveSession(chat({ id: "b" }));
    choosePubky();
    expect(faceChoice(PEER)).toEqual({ provider: "pubky", subject: PUBKY_KEY });
    deleteSession("a");
    expect(faceChoice(PEER)).toBeDefined();
    deleteSession("b");
    expect(faceChoice(PEER)).toBeUndefined();
  });
});

describe("the chat list", () => {
  it("shows the chosen identity's name and photo, the provider on the avatar's corner, the key in the tooltip", async () => {
    saveSession(chat());
    list([pubky()]);
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Ghost Bob");
    expect(within(row()).queryByTestId("contact-face-corner")).not.toBeInTheDocument();
    act(() => choosePubky());
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Alice Liddell");
    expect(within(row()).getByTestId("chat-row-avatar")).toHaveAttribute("src", AVATAR);
    expect(within(row()).getByTestId("contact-face-corner")).toHaveAttribute("data-provider", "pubky");
    expect(row().getAttribute("title")).toMatch(/^Alice Liddell · /);
    // The chosen identity's profile is asked for, as a card on screen is.
    await waitFor(() => expect(fakeEngine.callsTo("loadPublicProfile")).toContainEqual({ provider: "pubky", subject: PUBKY_KEY }));
  });

  it("keeps a nickname given here, with the identity's photo", () => {
    saveSession(chat({ label: "Mom" }));
    choosePubky();
    list([pubky()]);
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Mom");
    expect(within(row()).getByTestId("chat-row-avatar")).toHaveAttribute("src", AVATAR);
  });

  it("falls back to the contact's own name when the proof expires or is removed", () => {
    saveSession(chat());
    choosePubky();
    list([pubky()]);
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Alice Liddell");
    act(() => fakeEngine.update(withReceived([pubky({ expiresAt: now() - 1 })])));
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Ghost Bob");
    expect(within(row()).queryByTestId("contact-face-corner")).not.toBeInTheDocument();
    act(() => fakeEngine.update(withReceived([pubky()])));
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Alice Liddell");
    act(() => fakeEngine.update(withReceived([pubky({ status: "withdrawn" })])));
    expect(within(row()).getByTestId("chat-row-name")).toHaveTextContent("Ghost Bob");
  });

  it("finds a contact by the identity's name", async () => {
    saveSession(chat());
    saveSession(chat({ id: "b", peerPubKeyB64: "q".repeat(52), nick: "Carol" }));
    choosePubky();
    const { user } = list([pubky()]);
    await user.type(screen.getByPlaceholderText(/search/i), "liddell");
    expect(screen.getAllByTestId("chat-row").map(r => within(r).getByTestId("chat-row-name").textContent)).toEqual(["Alice Liddell"]);
  });
});

describe("the marks' card in the chat list", () => {
  it("opens on hover after a pause, names the identity, and never opens the chat", async () => {
    saveSession(chat());
    const { user } = list([pubky()]);
    const marks = within(row()).getByTestId("contact-marks");
    // The row's own tooltip (name and key) stays off the marks.
    expect(marks).toHaveAttribute("title", "");
    fireEvent.pointerOver(within(marks).getByTestId("contact-mark"), { pointerType: "mouse" });
    expect(screen.queryByTestId("contact-marks-tip")).not.toBeInTheDocument();
    const tip = await screen.findByTestId("contact-marks-tip");
    expect(within(tip).getByTestId("identity-tip-name")).toHaveTextContent("Alice Liddell");
    expect(tip).toHaveTextContent("Pubky · @alice");
    expect(within(tip).getByTestId("identity-tip-state")).toHaveTextContent(/^Verified /);
    expect(within(tip).getByTestId("identity-tip-source")).toHaveTextContent("Loaded from nexus.pubky.app");
    expect(within(tip).getByTestId("badge-mark-photo")).toHaveAttribute("src", AVATAR);
    expect(marks).toHaveAttribute("aria-describedby", tip.id);
    await waitFor(() => expect(fakeEngine.callsTo("loadPublicProfile")).toContainEqual({ provider: "pubky", subject: PUBKY_KEY }));
    fireEvent.pointerLeave(marks, { pointerType: "mouse" });
    expect(screen.queryByTestId("contact-marks-tip")).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    void user;
  });

  it("opens on keyboard focus with every mark, and Escape closes it", async () => {
    saveSession(chat());
    const { user } = list([pubky(), nostr()]);
    const marks = within(row()).getByTestId("contact-marks");
    act(() => marks.focus());
    const tip = screen.getByTestId("contact-marks-tip");
    expect(within(tip).getAllByTestId("identity-tip-identity").map(i => i.dataset.provider)).toEqual(["nostr", "pubky"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("contact-marks-tip")).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("opens on a long press, and the touch that ends it does not open the chat", async () => {
    saveSession(chat());
    list([pubky()]);
    const mark = within(row()).getByTestId("contact-mark");
    fireEvent.pointerDown(mark, { pointerType: "touch" });
    await screen.findByTestId("contact-marks-tip");
    fireEvent.pointerUp(mark, { pointerType: "touch" });
    fireEvent.click(mark);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    // A short tap is still the row's: it opens the chat.
    fireEvent.pointerDown(mark, { pointerType: "touch" });
    fireEvent.pointerUp(mark, { pointerType: "touch" });
    fireEvent.click(mark);
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/");
  });
});

describe("the header's marks", () => {
  it("open the same card, with the Ghostly key when the contact is shown as an identity", async () => {
    renderApp(<IdentityStack peerKey={PEER} name="Alice Liddell" onOpen={() => {}} footer="Shown with their Pubky profile · Ghostly key pppp…pppp" />);
    fakeEngine.on("loadPublicProfile", () => undefined);
    act(() => fakeEngine.update(withReceived([pubky()])));
    fireEvent.pointerOver(screen.getByTestId("chat-identity-badge"), { pointerType: "mouse" });
    const tip = await screen.findByTestId("chat-identity-tip");
    expect(within(tip).getByTestId("identity-tip-name")).toHaveTextContent("Alice Liddell");
    expect(within(tip).getByTestId("identity-tip-footer")).toHaveTextContent("Ghostly key");
  });
});

describe("Show as, in the contact's identities", () => {
  const panel = () => renderApp(<ContactIdentitiesPanel peerKey={PEER} name="Ghost Bob" onClose={() => {}} />);

  it("offers the only profile with one tap, and a choice back to Ghostly ends the offer", async () => {
    saveSession(chat());
    fakeEngine.on("loadPublicProfile", () => undefined);
    const { user } = panel();
    act(() => fakeEngine.update(withReceived([pubky()])));
    const offer = screen.getByTestId("contact-face-suggest");
    expect(offer).toHaveTextContent("Use Pubky name & photo");
    expect(offer).toHaveTextContent("Alice Liddell");
    // Offered, not applied.
    expect(faceChoice(PEER)).toBeUndefined();
    await user.click(offer);
    expect(faceChoice(PEER)).toEqual({ provider: "pubky", subject: PUBKY_KEY });
    expect(screen.queryByTestId("contact-face-suggest")).not.toBeInTheDocument();
    const select = screen.getByTestId("contact-face-select");
    expect(select).toHaveTextContent("Alice Liddell");
    await choose(user, select, "ghostly");
    expect(faceChoice(PEER)).toBe("none");
    expect(screen.queryByTestId("contact-face-suggest")).not.toBeInTheDocument();
  });

  it("lists Ghostly and each verified profile; a nickname keeps the name", async () => {
    saveSession(chat({ label: "Mom" }));
    fakeEngine.on("loadPublicProfile", () => undefined);
    const { user } = panel();
    act(() => fakeEngine.update(withReceived([pubky(), nostr(), receivedView()])));
    expect(screen.queryByTestId("contact-face-suggest")).not.toBeInTheDocument();
    const select = screen.getByTestId("contact-face-select");
    expect((await optionsOf(user, select)).map(o => o.label)).toEqual(["Ghostly (none)", "Alice Liddell", "Alice on Nostr"]);
    await user.keyboard("{Escape}");
    await choose(user, select, `nostr:${NOSTR_KEY}`);
    expect(faceChoice(PEER)).toEqual({ provider: "nostr", subject: NOSTR_KEY });
    expect(screen.getByTestId("contact-face-hint")).toHaveTextContent("Your nickname “Mom” stays; the photo is theirs.");
  });

  it("says so when the chosen profile's proof no longer holds", () => {
    saveSession(chat());
    choosePubky();
    fakeEngine.on("loadPublicProfile", () => undefined);
    panel();
    act(() => fakeEngine.update(withReceived([pubky({ status: "revoked" })])));
    expect(screen.getByTestId("contact-face-hint")).toHaveTextContent("proof no longer holds");
  });

  it("is not there for a contact with no public profile", () => {
    saveSession(chat());
    panel();
    act(() => fakeEngine.update(withReceived([receivedView()])));
    expect(screen.queryByTestId("contact-face")).not.toBeInTheDocument();
  });
});

describe("a group", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const group = groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Ghost Bob" }), member({ key: BOB, nick: "Bob" })], memberLinks: { "link-1": ALICE } });

  it("names a member who is a contact as their chosen identity, unless they have a nickname", () => {
    const links = withReceived([pubky()]).links;
    choosePubky();
    const faceOf = (key: string | undefined) => (key === PEER ? contactFace([pubky()], faceChoice(PEER)) : undefined);
    expect(withContactFaces(group, links, faceOf, () => undefined).members.map(m => m.nick)).toEqual([undefined, "Alice Liddell", "Bob"]);
    expect(withContactFaces(group, links, faceOf, () => "Mom").members.map(m => m.nick)).toEqual([undefined, "Ghost Bob", "Bob"]);
    expect(withContactFaces(group, links, () => undefined, () => undefined)).toBe(group);
  });

  it("offers the chosen identity's name in @ mentions", async () => {
    saveSession(chat());
    choosePubky();
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).on("loadPublicProfile", () => undefined);
    fakeEngine.update({ groups: [group], links: withReceived([pubky()]).links });
    const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await user.type(screen.getByRole("textbox"), "@");
    expect(within(screen.getByTestId("mention-picker")).getAllByRole("option").map(o => o.textContent)).toEqual(["Alice Liddell…" + ALICE.slice(-6), "Bob…" + BOB.slice(-6)]);
  });
});
