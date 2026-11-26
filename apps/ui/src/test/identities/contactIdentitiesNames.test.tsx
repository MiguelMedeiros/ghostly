// Identities → From your contacts names each contact as the chat list does (a nickname, else their own name), and
// follows it: a contact who renames themselves, or a nickname set for them, shows on the rows once their chat is saved
// (`session-updated`), without waiting for a change to what they shared. A chat that changes no name draws nothing.
import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesSection } from "../../components/identities/ContactIdentitiesSection";
import { saveSession, setSessionPinned, updateSessionLabel } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Identities } from "../../pages/Identities";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, proofView, receivedView, sharedView } from "./views";

// covers: proofs.page

const KEY = "peer";

function session(id: string, patch: Partial<ChatSession> = {}, peer = KEY): ChatSession {
  return { id, mySeedB64: "seed", peerPubKeyB64: peer, encKeyB64: "key", messages: [], createdAt: 0, ...patch } as ChatSession;
}
/** The engine's view of the chat, after the contact told it their name. */
const view = (nick: string, patch: Partial<LinkView> = {}) =>
  linkView({ id: "link-1", peerPubKeyZ32: KEY, peerNick: nick, identities: identitiesView({ received: [receivedView()] }), ...patch });
const row = () => within(screen.getByTestId("identities-received")).getByTestId("identity-received");
/** A chat saved, as the app tells its readers (the session sync, the chat's header). */
const saved = (s: ChatSession) => { saveSession(s); window.dispatchEvent(new Event("session-updated")); };

describe("Identities → From your contacts names the contact as the chat list does", () => {
  it("shows a contact's new name once they renamed themselves and their chat was saved", () => {
    saveSession(session("link-1", { nick: "Alice" }));
    renderApp(<Identities />);
    act(() => fakeEngine.update({ links: [view("Alice")] }));
    expect(row()).toHaveTextContent("Alice");

    act(() => fakeEngine.update({ links: [view("Bob")] }));
    act(() => saved(session("link-1", { nick: "Bob" })));
    expect(row()).toHaveTextContent("Bob");
    expect(row()).not.toHaveTextContent("Alice");
  });

  it("shows the nickname the person set for the contact", () => {
    saveSession(session("link-1", { nick: "Alice" }));
    renderApp(<Identities />);
    act(() => fakeEngine.update({ links: [view("Alice")] }));
    expect(row()).toHaveTextContent("Alice");

    act(() => { updateSessionLabel("link-1", "Aunt Ally"); window.dispatchEvent(new Event("session-updated")); });
    expect(row()).toHaveTextContent("Aunt Ally");
    expect(row()).not.toHaveTextContent("Alice");
  });

  it("names the contact who could not verify a proof by their new name too", () => {
    saveSession(session("link-1", { nick: "Alice" }));
    renderApp(<Identities />);
    const refused = (nick: string) => view(nick, { identities: identitiesView({ received: [receivedView()], shared: [sharedView({ id: "a", status: "rejected" })] }) });
    act(() => fakeEngine.update({ identityProofs: [proofView({ id: "a" })], links: [refused("Alice")] }));
    expect(screen.getByTestId("identity-proof-refused")).toHaveTextContent("Not verified by Alice");

    act(() => fakeEngine.update({ identityProofs: [proofView({ id: "a" })], links: [refused("Bob")] }));
    act(() => saved(session("link-1", { nick: "Bob" })));
    expect(screen.getByTestId("identity-proof-refused")).toHaveTextContent("Not verified by Bob");
  });

  it("draws nothing again for a chat change that names no one anew: a message in theirs or another chat, a pin", () => {
    saveSession(session("link-1", { nick: "Alice" }));
    saveSession(session("link-2", { nick: "Carol" }, "carol"));
    let commits = 0;
    renderApp(<Profiler id="section" onRender={() => { commits++; }}><ContactIdentitiesSection /></Profiler>);
    act(() => fakeEngine.update({ links: [view("Alice"), linkView({ id: "link-2", peerPubKeyZ32: "carol" })] }));
    expect(row()).toHaveTextContent("Alice");

    commits = 0;
    const message = [{ id: "m1", text: "hi", timestamp: 1, sender: "peer" }] as ChatSession["messages"];
    act(() => saved(session("link-1", { nick: "Alice", messages: message })));
    act(() => saved(session("link-2", { nick: "Carol", messages: message }, "carol")));
    act(() => { setSessionPinned("link-1", true); });
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(commits).toBe(0);
    expect(row()).toHaveTextContent("Alice");
  });
});
