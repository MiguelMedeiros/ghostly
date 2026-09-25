import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { badgeRank, badgeState, BADGE_ORDER, contactBadges, takeBadges } from "../../components/identities/contactBadges";
import { ContactMarks, IdentityStack } from "../../components/identities/ContactMarks";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import { groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";

// covers: proofs.badges

const withReceived = (received: ReceivedIdentityView[], patch: Partial<LinkView> = {}) =>
  ({ links: [linkView({ identities: identitiesView({ received }), ...patch })] });

const GOOGLE = "https://accounts.google.com";
/** One of each kind, in the reverse of the order the marks come in. */
const everyKind = () => [
  receivedView({ id: "bitcoin", provider: "bitcoin", subject: "bc1qexample" }),
  receivedView({ id: "ssh", provider: "ssh", subject: "SHA256:abcdefghijklmnopqrstuvwxyz" }),
  receivedView({ id: "pgp", provider: "openpgp", subject: "ABCDEF0123456789" }),
  receivedView({ id: "nostr", provider: "nostr", subject: "npub1example" }),
  receivedView({ id: "google", provider: "oidc", subject: GOOGLE, verified: { subject: `${GOOGLE}#42`, source: "ID token", attester: "accounts.google.com" } }),
  receivedView({ id: "github", provider: "ssh-github", subject: "octocat" }),
  receivedView({ id: "domain", provider: "domain", subject: "example.org" }),
];

describe("the order of a contact's marks", () => {
  it("is written once: domain, GitHub/GitLab, accounts, Nostr, OpenPGP, SSH, Bitcoin", () => {
    expect(BADGE_ORDER).toEqual(["domain", "ssh-github", "ssh-gitlab", "oidc:*", "nostr", "openpgp", "ssh", "bitcoin"]);
    expect(contactBadges(everyKind()).map(b => b.id)).toEqual(["domain", "github", "google", "nostr", "pgp", "ssh", "bitcoin"]);
  });

  it("ranks GitHub and GitLab together, every account at a provider together, anything unknown last", () => {
    expect(badgeRank("ssh-gitlab")).toBe(badgeRank("ssh-github"));
    expect(badgeRank("oidc", GOOGLE)).toBe(badgeRank("oidc", "https://issuer.example"));
    expect(badgeRank("oidc", "https://appleid.apple.com")).toBe(badgeRank("oidc"));
    expect(badgeRank("some-plugin")).toBe(BADGE_ORDER.length);
    // Equals keep the contact's order.
    const two = [receivedView({ id: "gitlab", provider: "ssh-gitlab", subject: "a" }), receivedView({ id: "github", provider: "ssh-github", subject: "b" })];
    expect(contactBadges(two).map(b => b.id)).toEqual(["gitlab", "github"]);
  });

  it("puts what is still vouched for before the rest", () => {
    const list = [receivedView({ id: "domain", status: "revoked" }), receivedView({ id: "bitcoin", provider: "bitcoin", subject: "bc1q" })];
    expect(contactBadges(list).map(b => b.id)).toEqual(["bitcoin", "domain"]);
  });
});

describe("a mark's state", () => {
  it("is verified, expiring, failed, revoked or expired; nothing for one withdrawn or from a previous key", () => {
    const t = now();
    expect(badgeState(receivedView(), t)).toBe("verified");
    expect(badgeState(receivedView({ verifiedAt: t - 80 * DAY, expiresAt: t + 2 * DAY }), t)).toBe("expiring");
    expect(badgeState(receivedView({ status: "unconfirmed" }), t)).toBe("failed");
    expect(badgeState(receivedView({ status: "revoked" }), t)).toBe("revoked");
    // Past its expiry, whatever the engine last said.
    expect(badgeState(receivedView({ expiresAt: t - DAY }), t)).toBe("expired");
    expect(badgeState(receivedView({ status: "withdrawn" }), t)).toBeUndefined();
    expect(badgeState(receivedView({ status: "previous-key" }), t)).toBeUndefined();
  });

  it("is named with its provider, its subject and when", () => {
    const t = now();
    const [badge] = contactBadges([receivedView({ provider: "ssh-github", subject: "mmedeiros", verified: { subject: "mmedeiros", source: "SSH" }, checkedAt: t - 2 * 3600 })], { now: t });
    expect(badge.label).toBe("GitHub (SSH key): mmedeiros · verified 2 hr. ago");
    const [revoked] = contactBadges([receivedView({ status: "revoked", checkedAt: t - 3 * DAY })], { now: t });
    expect(revoked.label).toBe("Domain: example.org · revoked by its owner, seen 3 days ago");
  });
});

describe("takeBadges", () => {
  it("keeps the first ones and counts the rest", () => {
    expect(takeBadges([1, 2, 3], 2)).toEqual({ shown: [1, 2], more: 1 });
    expect(takeBadges([1], 2)).toEqual({ shown: [1], more: 0 });
    expect(takeBadges([], 2)).toEqual({ shown: [], more: 0 });
  });
});

describe("ContactMarks (the chat list, a group's members)", () => {
  it("shows nothing until the contact has a verified identity", () => {
    const { engine } = renderApp(<ContactMarks peerKey="peer" />);
    expect(screen.queryByTestId("contact-marks")).not.toBeInTheDocument();
    act(() => engine.update(withReceived([receivedView({ status: "unconfirmed" }), receivedView({ id: "r2", status: "revoked" }), receivedView({ id: "r3", expiresAt: now() - DAY })])));
    expect(screen.queryByTestId("contact-marks")).not.toBeInTheDocument();
  });

  it("shows at most two marks, the most recognisable, and +N for the rest", () => {
    const { engine } = renderApp(<ContactMarks peerKey="peer" />);
    act(() => engine.update(withReceived(everyKind())));
    const marks = screen.getByTestId("contact-marks");
    expect(screen.getAllByTestId("contact-mark").map(m => m.dataset.icon)).toEqual(["domain", "ssh-github"]);
    expect(screen.getByTestId("contact-marks-more")).toHaveTextContent("+5");
    expect(marks).toHaveAccessibleName(/^Verified identities: Domain: example.org · verified/);
    expect(marks.getAttribute("aria-label")!.split("; ")).toHaveLength(7);
    // A narrow row: the second mark and its "+N" are for wide rows, the narrow "+N" counts one more.
    expect(screen.getAllByTestId("contact-mark")[1]).toHaveAttribute("data-wide");
    expect(marks.querySelector("[data-narrow]")).toHaveTextContent("+6");
  });

  it("counts only verified ones; two with no +N; one narrow still says +1", () => {
    const { engine } = renderApp(<ContactMarks peerKey="peer" />);
    act(() => engine.update(withReceived([receivedView({ id: "a" }), receivedView({ id: "b", provider: "nostr", subject: "npub1x" }), receivedView({ id: "c", provider: "bitcoin", subject: "bc1", status: "revoked" })])));
    expect(screen.getAllByTestId("contact-mark")).toHaveLength(2);
    expect(screen.queryByTestId("contact-marks-more")).not.toBeInTheDocument();
    expect(screen.getByTestId("contact-marks").querySelector("[data-narrow]")).toHaveTextContent("+1");
  });

  it("an expiring one is still shown, with its clock", () => {
    const { engine } = renderApp(<ContactMarks peerKey="peer" />);
    act(() => engine.update(withReceived([receivedView({ verifiedAt: now() - 80 * DAY, expiresAt: now() + DAY })])));
    const mark = screen.getByTestId("contact-mark");
    expect(mark).toHaveAttribute("data-state", "expiring");
    expect(mark.querySelector("[data-flag=expiring]")).not.toBeNull();
  });

  it("belongs to the contact it is given", () => {
    const { engine } = renderApp(<ContactMarks peerKey="someone-else" />);
    act(() => engine.update(withReceived([receivedView()])));
    expect(screen.queryByTestId("contact-marks")).not.toBeInTheDocument();
  });
});

describe("IdentityStack (the chat's header)", () => {
  it("stacks up to three marks, every state, with +N and one check per width", async () => {
    const onOpen = vi.fn();
    const { engine, user } = renderApp(<IdentityStack peerKey="peer" onOpen={onOpen} />);
    expect(screen.queryByTestId("chat-identity-badges")).not.toBeInTheDocument();
    act(() => engine.update(withReceived(everyKind())));
    const stack = screen.getByTestId("chat-identity-badges");
    expect(screen.getAllByTestId("chat-identity-badge").map(m => m.dataset.icon)).toEqual(["domain", "ssh-github", "oidc:google"]);
    // Three in a wide column, two in a narrow one, one on a phone: each width has its own "+N" and check.
    expect(screen.getByTestId("chat-identity-more-3")).toHaveTextContent("+4");
    expect(screen.getByTestId("chat-identity-more-2")).toHaveTextContent("+5");
    expect(screen.getByTestId("chat-identity-more-1")).toHaveTextContent("+6");
    for (const n of [1, 2, 3]) expect(screen.getByTestId(`chat-identity-check-${n}`)).toBeInTheDocument();
    expect(stack).toHaveAccessibleName(/^Identities: Domain: example.org · verified .*; GitHub \(SSH key\): octocat · verified/);
    await user.click(stack);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows revoked and failed ones too, and no check over them", () => {
    const { engine } = renderApp(<IdentityStack peerKey="peer" onOpen={() => {}} />);
    act(() => engine.update(withReceived([
      receivedView({ id: "domain" }),
      receivedView({ id: "nostr", provider: "nostr", subject: "npub1x", status: "unconfirmed" }),
      receivedView({ id: "pgp", provider: "openpgp", subject: "ABCD", status: "revoked" }),
    ])));
    const marks = screen.getAllByTestId("chat-identity-badge");
    expect(marks.map(m => m.dataset.state)).toEqual(["verified", "failed", "revoked"]);
    expect(marks[1].querySelector("[data-flag=failed]")).not.toBeNull();
    // The phone shows the verified domain alone: its check stays. Wider, a failed one is shown: no check.
    expect(screen.getByTestId("chat-identity-check-1")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-identity-check-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-identity-check-3")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-identity-more-1")).toHaveTextContent("+2");
    expect(screen.queryByTestId("chat-identity-more-3")).not.toBeInTheDocument();
  });

  it("names a mark on hover", () => {
    const { engine } = renderApp(<IdentityStack peerKey="peer" onOpen={() => {}} />);
    act(() => engine.update(withReceived([receivedView({ provider: "ssh-github", subject: "mmedeiros", verified: { subject: "mmedeiros", source: "SSH" }, checkedAt: now() - 7200 })])));
    fireEvent.pointerOver(screen.getByTestId("chat-identity-badge"), { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("GitHub (SSH key): mmedeiros · verified 2 hr. ago");
    fireEvent.pointerLeave(screen.getByTestId("chat-identity-badges"), { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("names a mark on a long press, and that press does not open anything", async () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      const { engine } = renderApp(<IdentityStack peerKey="peer" onOpen={onOpen} />);
      act(() => engine.update(withReceived([receivedView()])));
      const mark = screen.getByTestId("chat-identity-badge");
      fireEvent.pointerDown(mark, { pointerType: "touch" });
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByRole("tooltip")).toHaveTextContent(/^Domain: example.org · verified/);
      fireEvent.pointerUp(mark, { pointerType: "touch" });
      fireEvent.click(mark);
      expect(onOpen).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      // A plain tap opens.
      fireEvent.pointerDown(mark, { pointerType: "touch" });
      fireEvent.pointerUp(mark, { pointerType: "touch" });
      fireEvent.click(mark);
      expect(onOpen).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe("a group's member list", () => {
  it("shows a member's marks when that member is a contact who shared identities", () => {
    const ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
    const member = (key: string, patch = {}) => ({ key, role: "member" as const, me: false, online: true, missing: 0, ...patch });
    const group = groupView({ status: "active", members: [member(ME, { me: true }), member(ALICE, { nick: "Alice" }), member(BOB, { nick: "Bob" })], memberLinks: { "link-alice": ALICE } });
    const { engine } = renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
    act(() => engine.update({ groups: [group], links: [linkView({ id: "link-alice", peerPubKeyZ32: "alice-chat", identities: identitiesView({ received: everyKind() }) })] }));
    const row = (key: string) => screen.getAllByTestId("group-member").find(r => r.dataset.key === key)!;
    const marks = row(ALICE).querySelector<HTMLElement>("[data-testid=group-member-marks]")!;
    expect([...marks.querySelectorAll<HTMLElement>("[data-testid=contact-mark]")].map(m => m.dataset.icon)).toEqual(["domain", "ssh-github"]);
    expect(marks.querySelector("[data-testid=contact-marks-more]")).toHaveTextContent("+5");
    // Bob is no contact of mine: no marks.
    expect(row(BOB).querySelector("[data-testid=group-member-marks]")).toBeNull();
  });
});

describe("the chat list", () => {
  it("shows a contact's two most recognisable verified marks after their name, and +N", () => {
    const peer = "p".repeat(52);
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: Date.now(), nick: "Alice", nickSource: "profile" });
    const { engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: peer, identities: identitiesView({ received: everyKind() }) })] }));
    const row = screen.getAllByTestId("chat-row").find(r => r.textContent?.includes("Alice"))!;
    const marks = row.querySelector<HTMLElement>("[data-testid=contact-marks]")!;
    // After the name, in the line the time is on; the name keeps its own element (it truncates first).
    expect(marks.previousElementSibling).toHaveAttribute("data-testid", "chat-row-name");
    expect(marks.closest(".contact-row")).not.toBeNull();
    expect([...marks.querySelectorAll<HTMLElement>("[data-testid=contact-mark]")].map(m => m.dataset.icon)).toEqual(["domain", "ssh-github"]);
    expect(marks.querySelector("[data-testid=contact-marks-more]")).toHaveTextContent("+5");
  });
});
