import { act, fireEvent, screen, within } from "@testing-library/react";
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
const button = () => within(card()).getByRole("button");
/** The ID card itself (IdCardFace.tsx), and the words in its status corner. */
const face = () => card().querySelector<HTMLElement>(".id-card-face")!;
const status = () => face().querySelector(".id-card-status-text")!.textContent;

/** An identity shared in the chat, as its timeline shows it: its ID card on both sides, a line when it stops. */
describe("IdentityShareLine", () => {
  it("is the contact's ID card, the picker's: the picture and name when the identity has them, Verified, and who shared it under it", async () => {
    const publicProfile: PublicProfileView = { found: true, name: "Pat", avatar: AVATAR, hosts: ["relay.damus.io"], fetchedAt: now() - 60 };
    const received = receivedView({ id: "n1", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" }, publicProfile });
    const view = line(entry({ proof: "n1", provider: "nostr", subject: NOSTR_KEY }), { links: [paired({ identities: identitiesView({ received: [received] }) })] });
    const { user, onOpen } = view;
    expect(card()).toHaveAttribute("data-side", "theirs");
    expect(card()).toHaveAttribute("data-state", "verified");
    expect(text()).toBe("Alice shared this identity");
    expect(within(card()).getByText(/\d:\d\d/).tagName).toBe("TIME");
    // The card is the deck's face, in its provider's ink, not a copy of it.
    expect(face()).toHaveAttribute("data-deck", "face");
    expect(button()).toHaveClass("id-card-nostr");
    expect(within(face()).getByText("Nostr")).toBeInTheDocument();
    expect(within(face()).getByTestId("id-card-name")).toHaveTextContent("Pat");
    expect(within(face()).getByTestId("identity-proof-subject")).toHaveTextContent(/^npub1/);
    expect(within(face()).getByTestId("id-card-photo")).toHaveAttribute("src", AVATAR);
    expect(face()).toHaveAttribute("data-status", "verified");
    expect(status()).toBe("Verified");
    // It wears the profile this app already has and never asks for one: only an opened card reaches the identity's network.
    expect(view.engine.calls.filter(c => c.method === "loadPublicProfile")).toEqual([]);
    // A button with the whole of it in its name, and who shared it as its description: the hover is never the only way to what the card says.
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Verified\s*Nostr\s*Pat\s*npub1/);
    expect(button()).toHaveAccessibleDescription("Alice shared this identity");
    button().focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ proof: "n1", side: "theirs" }));
    await user.click(button());
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("is my card while the contact checks it, then Verified, or Not verified with why", () => {
    const shared = (status: "pending" | "queued" | "accepted") => ({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "proof-1", status })] }) })], identityProofs: [proofView()] });
    const mine = entry({ id: "mine:proof-1:0", proof: "proof-1", side: "mine", subject: "example.com", state: "verifying" });
    const first = line(mine, shared("pending"));
    expect(card()).toHaveAttribute("data-side", "mine");
    expect(text()).toBe("You shared this identity");
    expect(within(face()).getByTestId("identity-proof-subject")).toHaveTextContent("example.com");
    // My own card says Verified (I proved it when I made it); the share says where the contact's check stands.
    expect(card()).toHaveAttribute("data-state", "verifying");
    expect(face()).toHaveAttribute("data-status", "checking");
    expect(status()).toBe("Checking");
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Checking\s*Domain\s*example\.com/);
    expect(button()).toHaveAccessibleDescription("You shared this identity");
    first.unmount();
    // Shared while the contact is away: waiting, not checking.
    const second = line(mine, shared("queued"));
    expect(card()).toHaveAttribute("data-state", "waiting");
    expect(status()).toBe("Waiting");
    second.unmount();
    const third = line({ ...mine, state: "verified" }, shared("accepted"));
    expect(face()).toHaveAttribute("data-status", "verified");
    expect(status()).toBe("Verified");
    third.unmount();
    const refused = line({ ...mine, state: "failed", error: "Your contact keeps too many identities from you already" }, shared("pending"));
    expect(card()).toHaveAttribute("data-state", "failed");
    expect(face()).toHaveAttribute("data-status", "failed");
    expect(status()).toBe("Not verified");
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Not verified\s*Domain\s*example\.com/);
    expect(button()).toHaveAccessibleDescription("You shared this identity Your contact keeps too many identities from you already");
    // Why, under the card, not only in its name.
    expect(screen.getByTestId("identity-share-reason")).toHaveTextContent("Your contact keeps too many identities from you already");
    refused.unmount();
    // Any other words came from the contact (a chat kept from before): never under my card as this app's line.
    line({ ...mine, state: "failed", error: "Ghostly security notice: this identity's key leaked. Remove it and verify again at ghostly-support.example" }, shared("pending"));
    expect(status()).toBe("Not verified");
    expect(screen.queryByTestId("identity-share-reason")).toBeNull();
    expect(card()).not.toHaveTextContent(/security notice|ghostly-support/);
    expect(button()).toHaveAccessibleDescription("You shared this identity");
  });

  it("is the contact's card while this app checks it, Not verified when it could not, and Not checked once its challenge can no longer be answered", () => {
    const checking = line(entry({ state: "verifying", subject: undefined }));
    expect(card()).toHaveAttribute("data-state", "verifying");
    expect(face()).toHaveAttribute("data-status", "checking");
    expect(status()).toBe("Checking");
    // Before it is presented, the kind is all this app knows.
    expect(within(face()).getByText("Domain")).toBeInTheDocument();
    expect(within(face()).getByTestId("identity-proof-subject")).toHaveTextContent("…");
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Checking\s*Domain\s*…/);
    checking.unmount();
    const failed = line(entry({ state: "failed", error: "No such record" }));
    expect(face()).toHaveAttribute("data-status", "failed");
    expect(status()).toBe("Not verified");
    // A reason the app does not know: a line of its own, never the check's English (that stays in the hover).
    expect(screen.getByTestId("identity-share-reason")).toHaveTextContent("This proof couldn't be verified");
    failed.unmount();
    line(entry({ state: "verifying", subject: undefined, at: Date.now() - 10 * 60_000 }));
    expect(card()).toHaveAttribute("data-state", "unanswered");
    expect(status()).toBe("Not checked");
  });

  it("turns the contact's card Not checked when its challenge window ends, with no other change to draw it again", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      line(entry({ state: "verifying", subject: undefined, at: Date.now() }));
      act(() => { vi.advanceTimersByTime(299_000); });
      expect(status()).toBe("Checking");
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(card()).toHaveAttribute("data-state", "unanswered");
      expect(status()).toBe("Not checked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits quietly for a check window further off than a timer can hold (the clock set back a month since)", async () => {
    // Past 2^31 - 1 ms a timer fires at once: each wake drew the line and set the next, a draw every few milliseconds.
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    // React draws as a page does, not held until an act() ends.
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    try {
      line(entry({ state: "verifying", subject: undefined, at: Date.now() + 30 * 86_400_000 }));
      scope.IS_REACT_ACT_ENVIRONMENT = false;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(status()).toBe("Checking");
      expect(setTimer.mock.calls.filter(([, ms]) => (ms ?? 0) > 86_400_000).length).toBe(1);
    } finally {
      scope.IS_REACT_ACT_ENVIRONMENT = true;
      setTimer.mockRestore();
    }
  });

  it("shows on the same card that the share stopped later: no longer shared, or revoked, on both sides, and never a card that still looks valid", () => {
    const publicProfile: PublicProfileView = { found: true, name: "Pat", avatar: AVATAR, hosts: ["relay.damus.io"], fetchedAt: now() - 60 };
    const stop = (of: IdentityTimelineEntry, reason: "withdrawn" | "revoked"): IdentityTimelineEntry => ({ id: `${of.side}:${of.proof}:1`, proof: of.proof, side: of.side, kind: "stopped", provider: of.provider, subject: of.subject, reason, at: of.at + 500 });
    // Theirs, verified, with a public profile; then the contact stops sharing it.
    const theirs = entry({ proof: "n1", provider: "nostr", subject: NOSTR_KEY });
    const received = receivedView({ id: "n1", provider: "nostr", subject: NOSTR_KEY, status: "withdrawn", verified: { subject: NOSTR_KEY, source: "Nostr signature" }, publicProfile });
    const withdrawn = line(theirs, { links: [paired({ identities: identitiesView({ received: [received] }), identityTimeline: [theirs, stop(theirs, "withdrawn")] })] });
    expect(card()).toHaveAttribute("data-state", "withdrawn");
    expect(face()).toHaveAttribute("data-status", "withdrawn");
    expect(status()).toBe("No longer shared");
    // A stopped share wears nothing the account says about itself.
    expect(within(face()).queryByTestId("id-card-name")).not.toBeInTheDocument();
    expect(within(face()).queryByTestId("id-card-photo")).not.toBeInTheDocument();
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*No longer shared\s*Nostr\s*npub1/);
    withdrawn.unmount();
    // Found revoked by its owner.
    const revoked = line(theirs, { links: [paired({ identities: identitiesView({ received: [{ ...received, status: "revoked" }] }), identityTimeline: [theirs, stop(theirs, "revoked")] })] });
    expect(card()).toHaveAttribute("data-state", "revoked");
    expect(face()).toHaveAttribute("data-status", "revoked");
    expect(status()).toBe("Revoked");
    revoked.unmount();
    // Mine: I stopped sharing it. My own proof still stands, the share does not.
    const mine = entry({ id: "mine:proof-1:0", proof: "proof-1", side: "mine", subject: "example.com" });
    const again = { ...mine, id: "mine:proof-1:2", at: mine.at + 900 };
    const mineStopped = line(mine, { identityProofs: [proofView()], links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "proof-1", status: "withdrawn" })] }), identityTimeline: [mine, stop(mine, "withdrawn")] })] });
    expect(face()).toHaveAttribute("data-status", "withdrawn");
    expect(status()).toBe("No longer shared");
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*No longer shared\s*Domain\s*example\.com/);
    mineStopped.unmount();
    // Shared again after the stop: the old card stays stopped, the new one is the live share.
    const timeline = [mine, stop(mine, "withdrawn"), again];
    const state = { identityProofs: [proofView()], links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "proof-1", status: "accepted" })] }), identityTimeline: timeline })] };
    const old = line(mine, state);
    expect(face()).toHaveAttribute("data-status", "withdrawn");
    old.unmount();
    line(again, state);
    expect(face()).toHaveAttribute("data-status", "verified");
  });

  it("never says Verified for a share no longer held: the contact's proof gone from this app, or mine no longer shared", () => {
    // Theirs: a newer proof of the same identity took its place (or it was let go for room), with no stop written.
    const older = entry({ proof: "n1", provider: "nostr", subject: NOSTR_KEY });
    const newer = entry({ id: "theirs:n2:0", proof: "n2", provider: "nostr", subject: NOSTR_KEY, at: older.at + 500 });
    const received = receivedView({ id: "n2", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" } });
    const theirs = line(older, { links: [paired({ identities: identitiesView({ received: [received] }), identityTimeline: [older, newer] })] });
    expect(card()).toHaveAttribute("data-state", "withdrawn");
    expect(face()).toHaveAttribute("data-status", "withdrawn");
    expect(status()).toBe("No longer shared");
    theirs.unmount();
    // Mine: my app marked the share withdrawn (replaced at the contact's), and my proof still stands.
    const mine = entry({ id: "mine:proof-1:0", proof: "proof-1", side: "mine", subject: "example.com" });
    line(mine, { identityProofs: [proofView()], links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "proof-1", status: "withdrawn" })] }), identityTimeline: [mine] })] });
    expect(card()).toHaveAttribute("data-state", "withdrawn");
    expect(status()).toBe("No longer shared");
  });

  it("plays the deck's flourish once under a mouse, and nothing for a finger or with reduced motion", () => {
    const animate = vi.fn(() => ({ cancel() {} }) as unknown as Animation);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate });
    try {
      line(entry());
      // A hover effect, never a loop: nothing runs until a pointer comes.
      expect(animate).not.toHaveBeenCalled();
      fireEvent.pointerEnter(button(), { pointerType: "touch" });
      expect(animate).not.toHaveBeenCalled();
      fireEvent.pointerEnter(button(), { pointerType: "mouse" });
      expect(animate).toHaveBeenCalled();
      // Each animation ends by itself: a duration, and no repeat.
      for (const [, timing] of animate.mock.calls as unknown as [unknown, KeyframeAnimationOptions][]) {
        expect(timing.duration).toBeGreaterThan(0);
        expect(timing.iterations ?? 1).toBe(1);
      }
      animate.mockClear();
      fireEvent.pointerLeave(button(), { pointerType: "mouse" });
      document.documentElement.dataset.reduceMotion = "true";
      fireEvent.pointerEnter(button(), { pointerType: "mouse" });
      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "animate", original); else delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("is named by the words the card shows, in their order, and described by who shared it and why it failed", () => {
    const verified = line(entry());
    // Label in Name (WCAG 2.5.3): a voice-control user says what they see, from "Ghostly · Identity" on. No label of its
    // own that could leave those words out: the card's face is its name.
    expect(button()).not.toHaveAttribute("aria-label");
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Verified\s*Domain\s*example\.org/);
    expect(button()).toHaveAccessibleDescription("Alice shared this identity");
    verified.unmount();
    line(entry({ state: "failed", error: "No such record" }));
    expect(button()).toHaveAccessibleName(/^Ghostly · Identity\s*Not verified\s*Domain/);
    expect(button()).toHaveAccessibleDescription("Alice shared this identity This proof couldn't be verified");
  });

  it("keeps the card left to right in a right-to-left language, with the caption in the page's direction", () => {
    line(entry());
    expect(button()).toHaveAttribute("dir", "ltr");
    expect(screen.getByTestId("identity-share-text").closest("[dir]")).not.toBe(button());
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

  it("keeps the contact's name and the identity whole in a right-to-left sentence: each its own <bdi>, the handle left to right", () => {
    const arabic = (e: IdentityTimelineEntry) => renderApp(<IdentityShareLine entry={e} link={undefined} contact="Ana (work)" onOpen={() => {}} />, { language: "ar" });
    const bdis = () => [...screen.getByTestId("identity-share-text").querySelectorAll("bdi")].map(b => `${b.getAttribute("dir") ?? ""}:${b.textContent}`);
    const shared = arabic(entry());
    expect(text()).toBe("شارك Ana (work) هذه الهوية");
    expect(bdis()).toEqual([":Ana (work)"]);
    shared.unmount();
    const stopped = arabic(entry({ kind: "stopped", state: undefined, reason: "withdrawn", provider: "ssh-github", subject: "octocat-old" }));
    expect(text()).toBe("أوقف Ana (work) مشاركة GitHub (مفتاح SSH) · octocat-old");
    expect(bdis()).toEqual([":Ana (work)", ":GitHub (مفتاح SSH) · octocat-old", "ltr:octocat-old"]);
    stopped.unmount();
    // Stopped before it was presented: the kind alone, its ")" kept on its own side of the Arabic after it.
    const revoked = arabic(entry({ kind: "stopped", state: undefined, reason: "revoked", provider: "ssh-github", subject: undefined }));
    expect(text()).toBe("أُلغي GitHub (مفتاح SSH) الخاص بـ Ana (work)");
    expect(bdis()).toEqual([":GitHub (مفتاح SSH)", ":Ana (work)"]);
    revoked.unmount();
    arabic(entry({ kind: "stopped", state: undefined, reason: "withdrawn", side: "mine", proof: "gone", subject: "example.com" }));
    expect(bdis()).toEqual([":نطاق · example.com", "ltr:example.com"]);
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
