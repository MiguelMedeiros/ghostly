import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { encodeGroupEntryLink, randomBytes, toBase64Url, toZ32 } from "@ghostly/core";
import { npubEncode } from "nostr-tools/nip19";
import { loadIdentityProviders } from "@ghostly/browser/proofs/load";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, groupView, linkView, type StatePatch } from "../fakeEngine";
import { identitiesView, receivedView } from "../identities/views";
import { renderApp } from "../render";

// covers: chat.cards.identity, chat.cards.nostr, chat.cards.group

/**
 * The cards under a message (a DID, an npub, a group link) read the engine's state. The engine sends it anew on every
 * change, up to 20 times a second while a file moves: a card draws again only when what it shows changes.
 */

const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const NPUB = npubEncode("a".repeat(64));
const g = toBase64Url(randomBytes(16)), host = toZ32(randomBytes(32));
const RELAYS = ["wss://relay.one.example"];
/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));
const transfer = (i: number): StatePatch => ({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
const nostr = (relays: string[]): StatePatch => ({ nostr: { own: [], settings: { relays, autoLoadProfiles: false, publish: false } } });

function cards() {
  let draws = 0;
  const text = (id: string, t: string) => <MessageBubble message={{ id, text: t, sender: "peer", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />;
  renderApp(<Profiler id="cards" onRender={() => { draws++; }}>
    {text("m1", `my id ${DID_KEY}`)}
    {text("m2", `follow nostr:${NPUB}`)}
    {text("m3", encodeGroupEntryLink({ g, host }))}
  </Profiler>);
  return { draws: () => draws };
}

describe("entity cards on an engine state", () => {
  it("are not drawn again when nothing they show changed", async () => {
    fakeEngine.setState({ ...nostr(RELAYS), groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    const { draws } = cards();
    // The identity providers load once (not part of the app's first load): their draw is not counted.
    await act(() => loadIdentityProviders());
    expect(await screen.findByText("Book club")).toBeVisible();
    const before = draws();
    for (let i = 0; i < 5; i++) sentAgain(transfer(i));
    // A group's change the card does not show (a new message in it) draws nothing either.
    sentAgain({ groups: [groupView({ id: g, name: "Book club", status: "active", lastMessageAt: 5, lastPeerMessageAt: 5 })] });
    expect(draws() - before).toBe(0);
  });

  it("are drawn again when what they show changes", async () => {
    fakeEngine.setState(nostr(RELAYS));
    cards();
    const identity = screen.getByTestId("entity-identity");
    expect(identity).toHaveAttribute("data-standing", "none");
    sentAgain({ links: [linkView({ peerPubKeyZ32: "peer", identities: identitiesView({ received: [receivedView({ id: "did", provider: "did", subject: DID_KEY })] }) })] });
    expect(identity).toHaveAttribute("data-standing", "verified");
    expect(within(screen.getByTestId("entity-nostr")).getByTestId("entity-nostr-where")).toHaveTextContent("relay.one.example");
    sentAgain(nostr(["wss://relay.two.example"]));
    expect(within(screen.getByTestId("entity-nostr")).getByTestId("entity-nostr-where")).toHaveTextContent("relay.two.example");
    expect(screen.getByTestId("entity-group")).not.toHaveAttribute("data-member");
    sentAgain({ groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    expect(screen.getByTestId("entity-group")).toHaveAttribute("data-member", "true");
    expect(screen.getByTestId("entity-group")).toHaveTextContent("Book club");
  });
});
