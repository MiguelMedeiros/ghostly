import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IdentityTimelineEntry } from "@ghostly/core";
import type { LinkView, PublicProfileView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { IdentityShareLine } from "../../components/identities/IdentityShareLine";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import { mergeTimeline } from "../../lib/transportEvents";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, now, proofView, receivedView, sharedView } from "./views";

// covers: proofs.timeline, proofs.share, proofs.withdraw

const NOSTR_KEY = "b".repeat(64);
const AVATAR = "data:image/jpeg;base64,/9j/2Q==";
const entry = (patch: Partial<IdentityTimelineEntry> = {}): IdentityTimelineEntry =>
  ({ id: "theirs:received-1:0", proof: "received-1", side: "theirs", kind: "shared", provider: "domain", subject: "example.org", state: "verified", at: Date.now() - 1000, ...patch });
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

function line(e: IdentityTimelineEntry, state: Parameters<ReturnType<typeof renderApp>["engine"]["update"]>[0] = {}) {
  const onOpen = vi.fn();
  const view = renderApp(<IdentityShareLine entry={e} link={undefined} contact="Alice" onOpen={onOpen} />);
  act(() => view.engine.update(state));
  // The component reads the link from its prop: render it again with the state's link.
  view.rerender(<IdentityShareLine entry={e} link={view.engine.state?.links[0]} contact="Alice" onOpen={onOpen} />);
  return { onOpen, ...view };
}
const card = () => screen.getByTestId("identity-share");
const text = () => screen.getByTestId("identity-share-text").textContent;
const mark = () => screen.getByTestId("identity-share-state");

/** An identity shared in the chat, as its timeline shows it: a small ID card on both sides, a line when it stops. */
describe("IdentityShareLine", () => {
  it("is the contact's card: who shared what, the picture and name when the identity has them, and Verified", async () => {
    const publicProfile: PublicProfileView = { found: true, name: "Pat", avatar: AVATAR, hosts: ["relay.damus.io"], fetchedAt: now() - 60 };
    const received = receivedView({ id: "n1", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" }, publicProfile });
    const { user, onOpen } = line(entry({ proof: "n1", provider: "nostr", subject: NOSTR_KEY }), { links: [paired({ identities: identitiesView({ received: [received] }) })] });
    expect(card()).toHaveAttribute("data-side", "theirs");
    expect(text()).toBe("Alice shared Nostr");
    expect(screen.getByTestId("identity-share-name")).toHaveTextContent("Pat");
    expect(screen.getByTestId("identity-share-subject")).toHaveTextContent(/^npub1/);
    expect(screen.getByTestId("identity-share-photo")).toHaveAttribute("src", AVATAR);
    expect(mark()).toHaveAttribute("data-state", "verified");
    expect(mark()).toHaveAccessibleName("Verified");
    const button = within(card()).getByRole("button");
    expect(button).toHaveAccessibleName(/^Alice shared Nostr · npub1.* · Verified$/);
    await user.click(button);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ proof: "n1", side: "theirs" }));
  });

  it("is my card while the contact checks it, then Verified, or Not verified with why", () => {
    const shared = (status: "pending" | "queued") => ({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "proof-1", status })] }) })], identityProofs: [proofView()] });
    const mine = entry({ id: "mine:proof-1:0", proof: "proof-1", side: "mine", subject: "example.com", state: "verifying" });
    const first = line(mine, shared("pending"));
    expect(text()).toBe("You shared Domain");
    expect(screen.getByTestId("identity-share-subject")).toHaveTextContent("example.com");
    expect(mark()).toHaveAttribute("data-state", "verifying");
    first.unmount();
    // Shared while the contact is away: waiting, not checking.
    const second = line(mine, shared("queued"));
    expect(mark()).toHaveAccessibleName("Waiting");
    second.unmount();
    line({ ...mine, state: "failed", error: "The record is gone" });
    expect(mark()).toHaveAccessibleName("Not verified: The record is gone");
    expect(card()).toHaveAttribute("data-state", "failed");
    // Why, on the card itself, not only in a tooltip.
    expect(screen.getByTestId("identity-share-reason")).toHaveTextContent("The record is gone");
  });

  it("says the contact's share was never checked once its challenge can no longer be answered", () => {
    line(entry({ state: "verifying", subject: undefined, at: Date.now() - 10 * 60_000 }));
    expect(mark()).toHaveAccessibleName("Not checked");
    // Before it is presented, the kind is all the contact's app knows.
    expect(screen.getByTestId("identity-share-subject")).toHaveTextContent("…");
  });

  it("is a line when a share stops, or when the contact's proof turns out revoked", async () => {
    const stopped = line(entry({ kind: "stopped", state: undefined, reason: "withdrawn", side: "mine", proof: "gone", subject: "example.com" }));
    expect(card()).toHaveAttribute("data-kind", "stopped");
    expect(text()).toBe("You stopped sharing Domain · example.com");
    await stopped.user.click(within(card()).getByRole("button"));
    expect(stopped.onOpen).toHaveBeenCalledOnce();
    stopped.unmount();
    const theirs = line(entry({ kind: "stopped", state: undefined, reason: "withdrawn" }));
    expect(text()).toBe("Alice stopped sharing Domain · example.org");
    theirs.unmount();
    line(entry({ kind: "stopped", state: undefined, reason: "revoked" }));
    expect(text()).toBe("Alice’s Domain · example.org was revoked");
  });
});

describe("the chat's timeline", () => {
  it("puts identity shares between the messages by time, breaking a run of transport rows", () => {
    const messages = [{ id: "m1", timestamp: 10 }, { id: "m2", timestamp: 50 }];
    const transport = (id: string, at: number) => ({ id, kind: "connected", at, transport: "webrtc/1" }) as never;
    const rows = mergeTimeline(messages, [transport("a", 20), transport("b", 40)], [entry({ id: "s1", at: 5 }), entry({ id: "s2", at: 30 }), entry({ id: "s3", at: 60 })]);
    expect(rows.map(r => r.kind === "message" ? r.message.id : r.kind === "transport" ? `${r.entry.id}+${r.earlier.length}` : r.entry.id))
      .toEqual(["s1", "m1", "a+0", "s2", "b+0", "m2", "s3"]);
  });
});

describe("ContactIdentitiesPanel, opened from a share in the timeline", () => {
  it("opens on the contact's card that was tapped", () => {
    const received = [receivedView({ id: "r1", subject: "one.example" }), receivedView({ id: "r2", subject: "two.example" })];
    const view = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" card={{ side: "theirs", id: "r2" }} onClose={() => {}} />);
    act(() => view.engine.update({ links: [paired({ identities: identitiesView({ received }) })] }));
    const chosen = within(screen.getByTestId("chat-identities-received")).getAllByRole("radio").find(r => r.getAttribute("aria-checked") === "true");
    expect(chosen).toHaveTextContent("two.example");
  });

});

describe("the composer's picker, opened from a share of mine in the timeline", () => {
  it("opens on my card that was tapped", () => {
    // The proofs are there as the picker opens, as they are when a share of mine is on screen.
    fakeEngine.update({ links: [paired()], identityProofs: [proofView({ id: "p1" }), proofView({ id: "p2", subject: "example.net" })] });
    renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" initial="p2" onClose={() => {}} />);
    const chosen = within(screen.getByTestId("composer-identities")).getAllByRole("radio").find(r => r.getAttribute("aria-checked") === "true");
    expect(chosen).toHaveTextContent("example.net");
  });
});

describe("the chat list, after the contact shared an identity", () => {
  it("says so in the last message's place, and it is not unread", () => {
    const NOW = Date.now();
    const base = { profile: "paired-chat/1" as const, mySeedB64: "seed", encKeyB64: "enc", createdAt: NOW - 60_000, nick: "Alice", nickSource: "profile" as const };
    saveSession({ ...base, id: "a", peerPubKeyB64: "a".repeat(52), lastSyncAt: NOW, identitySharedAt: NOW, messages: [{ id: "m", text: "hi", sender: "peer", timestamp: NOW - 30_000 }] });
    saveSession({ ...base, id: "b", nick: "Bob", peerPubKeyB64: "b".repeat(52), lastSyncAt: NOW, identitySharedAt: NOW - 50_000, messages: [{ id: "m2", text: "later text", sender: "peer", timestamp: NOW - 10_000 }] });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const rows = screen.getAllByTestId("chat-row");
    const alice = rows.find(r => r.textContent?.includes("Alice"))!, bob = rows.find(r => r.textContent?.includes("Bob"))!;
    expect(within(alice).getByTestId("chat-row-note")).toHaveTextContent("Shared an identity");
    expect(within(alice).getByTestId("chat-row-unread")).toHaveTextContent("1");
    // A message after the share is the preview again.
    expect(within(bob).queryByTestId("chat-row-note")).not.toBeInTheDocument();
    expect(bob).toHaveTextContent("later text");
  });
});
