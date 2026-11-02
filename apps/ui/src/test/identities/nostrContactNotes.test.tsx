import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import type { NostrContactView, NostrNoteView, NostrOwnView } from "@ghostly/browser/nostr/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { NostrSection } from "../../components/nostr/NostrSection";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, now, receivedView } from "./views";

// covers: nostr.social.notes, nostr.social.follows

/**
 * Every engine state carries the chat's Nostr view and the person's own lists, and the extension's port sends each
 * state as JSON: they hold counts, and the card asks for the posts it shows (`nostrContactNotes`) while it is open.
 */
const npub = "npub1example";
const relays = ["wss://relay.test"];
// One load time for the file: a state built a second later carries the same posts, not posts loaded anew.
const fetchedAt = now() - 30;
const note = (id: string, content: string): NostrNoteView => ({ id, createdAt: fetchedAt - 30, content, reply: false });
const notesView = (patch: Partial<NonNullable<NostrContactView["notes"]>> = {}): NostrContactView => ({
  subject: npub, npub, notes: { fetchedAt, relays, count: 2, more: false, hidden: 0, authorMuted: false, ...patch },
});
const chat = (nostr: NostrContactView) => ({ links: [linkView({
  pairing: { status: "ready" } as LinkView["pairing"],
  identities: identitiesView({ received: [receivedView({ provider: "nostr", subject: npub, verified: { subject: npub, source: "Nostr signature" } })] }),
  nostr: [nostr],
})] });

async function openCard(nostr: NostrContactView) {
  const view = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
  document.documentElement.dataset.reduceMotion = "true";
  act(() => view.engine.update(chat(nostr)));
  await view.user.click(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]);
  return view;
}

describe("a contact's Nostr posts", () => {
  it("are asked once when the card opens, kept through later states, and asked again when loaded anew", async () => {
    let answer!: (notes: NostrNoteView[]) => void;
    fakeEngine.on("nostrContactNotes", () => new Promise<NostrNoteView[]>(resolve => { answer = resolve; }));
    const { engine } = await openCard(notesView());
    expect(screen.getByTestId("nostr-notes-loading")).toHaveTextContent("Loading…");
    expect(engine.callsTo("nostrContactNotes")).toEqual([{ linkId: "link-1", subject: npub }]);
    await act(async () => answer([note("n1", "hello"), note("n2", "again")]));
    expect(screen.getAllByTestId("nostr-note").map(li => li.firstChild!.textContent)).toEqual(["hello", "again"]);

    // Another engine state, same posts: nothing asked (the ask goes out a microtask after the render, so it is waited).
    await act(async () => engine.update(chat(notesView())));
    expect(engine.callsTo("nostrContactNotes")).toHaveLength(1);

    // Loaded again (older ones added): asked again, the list shown meanwhile.
    fakeEngine.on("nostrContactNotes", () => [note("n1", "hello"), note("n2", "again"), note("n3", "older")]);
    await act(async () => engine.update(chat(notesView({ count: 3, fetchedAt: fetchedAt + 30 }))));
    expect(engine.callsTo("nostrContactNotes")).toHaveLength(2);
    expect(screen.getAllByTestId("nostr-note")).toHaveLength(3);
  });

  it("asks nothing when none are shown, and says why the posts could not be read", async () => {
    fakeEngine.on("nostrContactNotes", () => { throw new Error("Peer is offline"); });
    const { engine } = await openCard(notesView({ count: 0 }));
    expect(screen.getByTestId("nostr-notes-none")).toBeInTheDocument();
    expect(engine.callsTo("nostrContactNotes")).toEqual([]);
    await act(async () => engine.update(chat(notesView())));
    expect(await screen.findByTestId("nostr-notes-error")).toHaveTextContent(/offline/i);
  });
});

it("Identities → Nostr counts the person's follow list from the state's count", () => {
  renderApp(<NostrSection />);
  const own: NostrOwnView = { subject: "a".repeat(64), npub: "npub1own", follows: { fetchedAt: now(), relays, stale: false, count: 2000, eventAt: 0 } };
  act(() => fakeEngine.update({ nostr: { own: [own], settings: { relays, autoLoadProfiles: false, publish: false } } }));
  expect(screen.getByTestId("nostr-own-follows")).toHaveTextContent(/You follow 2,?000 accounts\./);
});
