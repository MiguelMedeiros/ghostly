// The engine sends its whole state anew on every change (up to 20 a second while a file moves). What shows identities
// (the ID card lines in a chat's timeline, the composer's picker, a contact's identities beside the chat, the
// Identities page) draws again only when what it shows changes: a state that changes nothing of it draws nothing.
import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IdentityTimelineEntry } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import type { NostrContactView, NostrOwnView } from "@ghostly/browser/nostr/types";
import { IdentityShareLine } from "../../components/identities/IdentityShareLine";
import { IdentityPicker } from "../../components/identities/ComposerIdentities";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { NostrContactCard } from "../../components/nostr/NostrContactCard";
import { Identities } from "../../pages/Identities";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { linkView, type FakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, proofView, receivedView, sharedView } from "./views";

// covers: proofs.timeline, proofs.composer, proofs.page

const LINES = 20;
const NPUB = "npub1example";
const mineId = (i: number) => `proof-${i}`;
const theirsId = (i: number) => `received-${i}`;

/** Half the lines are my shares (a domain proof each), half the contact's. */
const entries: IdentityTimelineEntry[] = Array.from({ length: LINES }, (_, i) => {
  const mine = i % 2 === 0;
  return {
    id: `${mine ? "mine" : "theirs"}:${mine ? mineId(i) : theirsId(i)}:0`, proof: mine ? mineId(i) : theirsId(i),
    side: mine ? "mine" : "theirs", kind: "shared", provider: "domain", subject: `site-${i}.example`, state: "verified", at: Date.now() - 1000,
  };
});

/** The engine's state as it sends it: every list and object anew, nothing kept from the last one. */
function fresh(patch: { subject?: [index: number, subject: string] } = {}) {
  const subject = (i: number) => (patch.subject?.[0] === i ? patch.subject[1] : `site-${i}.example`);
  const mine = entries.flatMap((_, i) => (i % 2 === 0 ? [proofView({ id: mineId(i), subject: subject(i) })] : []));
  const received = entries.flatMap((_, i) => (i % 2 === 1 ? [receivedView({ id: theirsId(i), subject: subject(i) })] : []));
  const link = linkView({
    pairing: { status: "ready" } as LinkView["pairing"],
    identities: identitiesView({ shared: mine.map(p => sharedView({ id: p.id, subject: p.subject })), received }),
    nostr: [{ subject: NPUB } as NonNullable<LinkView["nostr"]>[number]],
  });
  const own: NostrOwnView[] = [{ subject: "c".repeat(64), npub: "npub1own" }];
  return { identityProofs: mine, links: [link], nostr: { own, settings: { relays: ["wss://relay.example"], autoLoadProfiles: false, publish: false } } };
}

/** 20 states that change only the file transfers, each a whole new state. */
function transfersOnly(engine: FakeEngine) {
  for (let i = 0; i < 20; i++) {
    act(() => engine.setState({ ...fresh(), transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 100_000 } } } as never));
  }
}

describe("an engine state that changes nothing of what shows identities", () => {
  it("draws none of a chat's ID card lines, and a changed proof draws only its own line", () => {
    const commits = entries.map(() => 0);
    const view = renderApp(<></>);
    act(() => view.engine.setState(fresh() as never));
    const link = view.engine.state!.links[0];
    view.rerender(<>{entries.map((entry, i) => (
      <Profiler key={entry.id} id={entry.id} onRender={() => { commits[i]++; }}>
        <IdentityShareLine entry={entry} link={link} contact="Alice" onOpen={() => {}} />
      </Profiler>
    ))}</>);
    expect(screen.getAllByTestId("identity-share")).toHaveLength(LINES);

    commits.fill(0);
    transfersOnly(view.engine);
    expect(commits.reduce((a, b) => a + b, 0)).toBe(0);

    // My proof on line 4 changes: that line draws again, and no other.
    act(() => view.engine.setState(fresh({ subject: [4, "changed.example"] }) as never));
    expect(commits[4]).toBeGreaterThan(0);
    expect(commits.filter((n, i) => i !== 4 && n > 0)).toEqual([]);
    expect(within(screen.getAllByTestId("identity-share")[4]).getByTestId("identity-proof-subject")).toHaveTextContent("changed.example");
  });

  it("does not draw the composer's identity picker", () => {
    let commits = 0;
    const view = renderApp(<Profiler id="picker" onRender={() => { commits++; }}>
      <IdentityPicker peerKey="peer" contact="Alice" onManage={() => {}} frame={(_, children) => children} />
    </Profiler>);
    act(() => view.engine.setState(fresh() as never));
    expect(screen.getAllByTestId("composer-identity")).toHaveLength(LINES / 2);
    commits = 0;
    transfersOnly(view.engine);
    expect(commits).toBe(0);
    // A proof it shows changes: it draws again.
    act(() => view.engine.setState(fresh({ subject: [4, "changed.example"] }) as never));
    expect(commits).toBeGreaterThan(0);
  });

  it("does not draw a contact's identities beside the chat", async () => {
    let commits = 0;
    const view = renderApp(<Profiler id="panel" onRender={() => { commits++; }}>
      <ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />
    </Profiler>);
    act(() => view.engine.setState(fresh() as never));
    expect(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")).toHaveLength(LINES / 2);
    commits = 0;
    transfersOnly(view.engine);
    expect(commits).toBe(0);
    act(() => view.engine.setState(fresh({ subject: [5, "changed.example"] }) as never));
    expect(commits).toBeGreaterThan(0);
  });

  it("does not draw the Identities page", () => {
    saveSession({ id: "chat-alice", mySeedB64: "seed", peerPubKeyB64: "peer", encKeyB64: "key", messages: [], createdAt: 0, label: "Alice" } as ChatSession);
    let commits = 0;
    const view = renderApp(<Profiler id="page" onRender={() => { commits++; }}>
      <Identities />
    </Profiler>);
    act(() => view.engine.setState(fresh() as never));
    expect(screen.getAllByTestId("identity-proof")).toHaveLength(LINES / 2);
    expect(screen.getAllByTestId("identity-received")).toHaveLength(LINES / 2);
    expect(screen.getByTestId("nostr-section")).toBeInTheDocument();
    commits = 0;
    transfersOnly(view.engine);
    expect(commits).toBe(0);
    act(() => view.engine.setState(fresh({ subject: [4, "changed.example"] }) as never));
    expect(commits).toBeGreaterThan(0);
  });

  it("does not draw a contact's Nostr card", () => {
    let commits = 0;
    const view = renderApp(<Profiler id="nostr" onRender={() => { commits++; }}>
      <NostrContactCard linkId="link-1" view={{ subject: NPUB } as NostrContactView} name="Alice" />
    </Profiler>);
    act(() => view.engine.setState(fresh() as never));
    expect(screen.getByTestId("nostr-contact")).toHaveTextContent("relay.example");
    commits = 0;
    transfersOnly(view.engine);
    expect(commits).toBe(0);
    // The relays it names change: it draws again.
    act(() => view.engine.setState({ ...fresh(), nostr: { ...fresh().nostr, settings: { relays: ["wss://other.example"], autoLoadProfiles: false, publish: false } } } as never));
    expect(screen.getByTestId("nostr-contact")).toHaveTextContent("other.example");
  });
});
