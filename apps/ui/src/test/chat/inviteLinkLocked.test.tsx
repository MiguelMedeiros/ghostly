import { render, waitFor, act, screen } from "@testing-library/react";
import { createChatInvite, createDeviceInvite, createIdentity, createLink, encodeInviteCode } from "@ghostly/core";
import { afterEach, expect, it, vi, describe } from "vitest";
import { Root } from "../../Root";
import { takeDeviceLink } from "../../lib/devices";
import { ensureSession, LINK_CHATS_WAITING, listSessions } from "../../lib/storage";
import { readInvite } from "../../lib/url";
import { axeViolations } from "../axe";
import { fakeEngine } from "../fakeEngine";

// covers: invite.link, profiles.lock

/*
 * An invite link opened while the app is locked: the code leaves the address at once (it holds the chat's keys), but
 * nothing is written into the profile before the lock is passed. The chat is made, and opens, after it.
 */
const lock = vi.hoisted(() => ({ isLocked: true }));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({
    isLocked: lock.isLocked, hasUnlocked: !lock.isLocked, retryAt: null, ringing: [],
    lock: () => {}, unlock: async () => false, resetTimer: () => {}, offerCall: () => () => {},
  }),
}));

afterEach(() => { window.location.hash = ""; lock.isLocked = true; takeDeviceLink(); });

it("an invite link opened while locked makes its chat only after the lock is passed", async () => {
  const code = createChatInvite().inviteCode;
  window.location.hash = `#${code}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(listSessions()).toHaveLength(0);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  const [chat] = listSessions();
  expect(chat.viaLink).toBe(true);
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${chat.id}`));
  expect(window.location.hash).not.toContain(code);
}, 60_000);

// covers: invite.link, profiles.lock
/*
 * Several invite links opened while locked (a tab that takes the profile over opens every link no tab answered, one
 * after the other): each makes its chat after the unlock, the same one once, and one past what links may make waiting
 * (`LINK_CHATS_WAITING`) is refused, said then. Only the last used to be kept.
 */
it("invite links opened while locked each make their chat after the unlock, up to the links' limit", async () => {
  const codes = [createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode];
  window.location.hash = `#${codes[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const code of [codes[1], codes[0], codes[2], codes[3]]) {
    window.location.hash = `#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }
  expect(listSessions()).toHaveLength(0);
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(3));
  const peerOf = (code: string) => { const reading = readInvite(code); return reading.ok ? reading.keys.peerPubKeyB64 : null; };
  expect(listSessions().map((s) => s.peerPubKeyB64).sort()).toEqual(codes.slice(0, 3).map(peerOf).sort());
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(listSessions()).toHaveLength(3);
}, 60_000);

// covers: invite.link, profiles.lock, chat.paired.join-notice
/*
 * Invite links held under the lock open one after the other after the unlock: only the chat the app lands on (the
 * last link's) says its join notice. An earlier link's "You're already in this chat" sat over the next chat opened.
 */
it.each([
  ["a chat already here, then a new one: no notice over the new chat", ["joined", "new"], null],
  ["this profile's own invite, then a new chat: no notice over the new chat", ["own", "new"], null],
  ["a new chat, then one already here: that one still says so", ["new", "joined"], "You're already in this chat."],
] as const)("invite links held under the lock, %s", async (_, kinds, notice) => {
  const codes = kinds.map((kind) => {
    const { mine, inviteCode } = createChatInvite();
    const reading = readInvite(inviteCode);
    if (kind === "joined" && reading.ok) ensureSession(reading.keys);
    if (kind === "own") ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1" });
    return inviteCode;
  });
  window.location.hash = `#${codes[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  window.location.hash = `#${codes[1]}`;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/"));

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(2));
  const last = readInvite(codes[1]);
  const landed = listSessions().find((s) => last.ok && s.peerPubKeyB64 === last.keys.peerPubKeyB64)!;
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${landed.id}`));
  if (notice) expect(screen.getByTestId("join-notice")).toHaveTextContent(notice);
  else expect(screen.queryByTestId("join-notice")).toBeNull();
}, 60_000);

// covers: invite.link, groups.link.join, profiles.lock, chat.paired.join-notice
/*
 * A group's link held under the same lock as one to a chat already here, in either order: the group's join answers
 * after the chat opened, and the app lands on the group. The chat's "You're already in this chat" is not said over it.
 */
it.each([
  ["the chat's link first", false],
  ["the group's link first", true],
])("a chat already here and a group's link held under the lock, %s: no notice over the group", async (_, groupFirst) => {
  fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
  const code = createChatInvite().inviteCode;
  const reading = readInvite(code);
  if (!reading.ok) throw new Error("a fresh invite reads");
  ensureSession(reading.keys);
  const hashes = groupFirst ? ["#/join/group2/abc", `#${code}`] : [`#${code}`, "#/join/group2/abc"];
  window.location.hash = hashes[0];
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  window.location.hash = hashes[1];
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/"));

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(window.location.hash).toBe("#/group/g1");
  expect(screen.queryByTestId("join-notice")).toBeNull();
}, 60_000);

// covers: invite.link, chat.paired.join-notice
it("an invite link to a chat already here, opened while unlocked, says so at once", async () => {
  const code = createChatInvite().inviteCode;
  const reading = readInvite(code);
  if (!reading.ok) throw new Error("a fresh invite reads");
  const id = ensureSession(reading.keys);
  lock.isLocked = false;
  render(<Root />);
  await screen.findByTestId("sidebar");
  window.location.hash = `#${code}`;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${id}`));
  expect(await screen.findByTestId("join-notice")).toHaveTextContent("You're already in this chat.");
}, 60_000);

// covers: invite.link, profiles.lock
/*
 * Links with a joined chat's seed but another contact's keys, opened while locked: each would make a chat of its own,
 * so each takes a place, and those past the limit are refused. The joined chat's own link takes none.
 */
it("links with a joined chat's seed but other keys, opened while locked, take places like new ones", async () => {
  const { invite, inviteCode } = createChatInvite();
  const reading = readInvite(inviteCode);
  if (!reading.ok) throw new Error("a fresh invite reads");
  const joined = ensureSession(reading.keys);
  const others = Array.from({ length: LINK_CHATS_WAITING + 3 }, () =>
    encodeInviteCode({ ...invite, peerPubKeyZ32: createIdentity().pubKeyZ32, encKeyB64: createLink().mine.encKeyB64 }));
  window.location.hash = "#/";
  const { rerender } = render(<Root />);
  for (const code of [...others, inviteCode]) {
    window.location.hash = `#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }
  expect(listSessions()).toHaveLength(1);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${joined}`));
  expect(listSessions()).toHaveLength(1 + LINK_CHATS_WAITING);
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened");
}, 60_000);

// covers: invite.link, profiles.lock
/*
 * A link that comes after the one refused past the limit, still under the lock (one already held again, or a group's
 * link): the refusal, not yet said, stays to be said after the unlock. Wiped, the refused link was lost with no word.
 */
it.each([
  ["an invite link already held", (codes: string[]) => `#${codes[0]}`],
  ["a group's link", () => "#/join/group2/after"],
  ["a device code's link", () => `#${createDeviceInvite(new Uint8Array(32).fill(7)).code}`],
  ["a device code's link that names the profile", () => `#Ana#${createDeviceInvite(new Uint8Array(32).fill(7)).code}`],
])("the refusal of an invite link past the limit is still said after the unlock when %s comes next", async (_, next) => {
  const codes = [createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode];
  window.location.hash = `#${codes[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const hash of [`#${codes[1]}`, `#${codes[2]}`, `#${codes[3]}`, next(codes)]) {
    window.location.hash = hash;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(3));
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened");
}, 60_000);

// covers: invite.invalid, invite.link, profiles.lock
/*
 * An invite link the app refuses (here a damaged one: its end cut off) opened while the app is locked: it leaves the address at once,
 * but the refusal is said once the lock is passed, not under the lock screen where nobody reads it. Locked or not, the
 * notice stays until it is closed (its ×, Escape), as a group link's refusal does, and the focus goes back where it was.
 * A good link that comes next takes the notice away: left there, it would read as the refusal of the chat that opened.
 */
describe("a refused invite link and the lock screen", () => {
  afterEach(() => { vi.useRealTimers(); window.location.hash = ""; lock.isLocked = true; });

  /** What a code with characters missing reads as: its checksum fails. */
  const REFUSAL = "This code has a typo. Check it, or ask for the code again.";

  /** A fresh invite's code with its end cut off: a damaged link. */
  const damaged = () => createChatInvite().inviteCode.slice(0, -5);

  /** The address is set on the running page. */
  function go(hash: string): void {
    window.location.hash = hash;
    // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  }

  /** Escape pressed where the focus is. The notice listens from an effect: press until it is heard. */
  async function escape(): Promise<void> {
    await waitFor(() => {
      act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
    });
  }

  it("a damaged link opened while locked is said after the unlock, and stays past 6 s until Escape closes it", async () => {
    window.location.hash = `#/${damaged()}`;
    const { rerender } = render(<Root />);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    // Long enough for a notice drawn at once (under the lock screen) to show.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();

    // From the unlock on, the clock is the test's: a notice that hid itself after 6 s would be gone below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    lock.isLocked = false;
    rerender(<Root />);
    await act(async () => {});
    expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);
    act(() => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
    const notice = screen.getByTestId("invite-link-invalid");
    expect(notice).toHaveTextContent(REFUSAL);
    expect(notice).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("invite-link-invalid-close")).toHaveAccessibleName("Close");
    expect(await axeViolations(notice.parentElement!)).toEqual([]);

    await escape();
    expect(listSessions()).toEqual([]);
  }, 60_000);

  it("unlocked, a refused link's notice stays past 6 s, its × closes it and the focus goes back where it was", async () => {
    lock.isLocked = false;
    render(<Root />);
    await screen.findByTestId("sidebar");
    // Where the focus was when the link came: a control the link's trip through the router leaves in place (the
    // sidebar's own buttons are drawn anew on the way home).
    const before = document.body.appendChild(document.createElement("button"));
    act(() => before.focus());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    go(`#/${damaged()}`);
    await act(async () => {});
    expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);
    act(() => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
    expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);

    // Enter on the ×: the focus is on it when it goes.
    const close = screen.getByTestId("invite-link-invalid-close");
    act(() => { close.focus(); close.click(); });
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
    expect(document.activeElement).toBe(before);

    // Escape, from the notice's own ×, gives the focus back too.
    go(`#/${damaged()}`);
    await screen.findByTestId("invite-link-invalid");
    act(() => screen.getByTestId("invite-link-invalid-close").focus());
    await escape();
    expect(document.activeElement).toBe(before);
    before.remove();
  }, 60_000);

  it("a good invite opened while locked still makes its chat after the unlock, with no refusal", async () => {
    window.location.hash = `#${createChatInvite().inviteCode}`;
    const { rerender } = render(<Root />);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(listSessions()).toHaveLength(0);

    lock.isLocked = false;
    rerender(<Root />);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  it("a refused link's notice goes when a good invite comes next: it would read as the new chat's refusal", async () => {
    lock.isLocked = false;
    render(<Root />);
    await screen.findByTestId("sidebar");
    go(`#/${damaged()}`);
    expect(await screen.findByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);

    go(`#${createChatInvite().inviteCode}`);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  it("locked, a damaged link and then a good one: after the unlock the chat opens with no refusal over it", async () => {
    window.location.hash = `#/${damaged()}`;
    const { rerender } = render(<Root />);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    go(`#${createChatInvite().inviteCode}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));

    lock.isLocked = false;
    rerender(<Root />);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  /*
   * A refusal said before the lock is no link's past the limit: a group's link held under it answers for itself, and the
   * notice left there would sit over the group that link opens after the unlock.
   */
  it("a refusal said before the lock goes when a group's link held under it opens its group after the unlock", async () => {
    fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
    lock.isLocked = false;
    const { rerender } = render(<Root />);
    await screen.findByTestId("sidebar");
    go(`#/${damaged()}`);
    expect(await screen.findByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);

    lock.isLocked = true;
    rerender(<Root />);
    go("#/join/group2/abc");
    await waitFor(() => expect(window.location.hash).toBe("#/"));

    lock.isLocked = false;
    rerender(<Root />);
    await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);
});

// covers: invite.link, profiles.lock
/*
 * Invite links to chats already here, opened under the lock, take no place among the links that may make chats: unlocked,
 * they open their chats, and the new chat's link after them is made. Counted, it was refused as one too many, "delete a
 * chat that got no answer" with none waiting.
 */
it("invite links to chats already here, opened while locked, leave room for a new chat's link", async () => {
  const codes = [createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode];
  for (const code of codes.slice(0, 3)) { const reading = readInvite(code); if (reading.ok) ensureSession(reading.keys); }
  window.location.hash = `#${codes[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const code of codes.slice(1)) {
    window.location.hash = `#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }
  expect(listSessions()).toHaveLength(3);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(4));
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
}, 60_000);

// covers: invite.link, profiles.lock
/*
 * An invite link to a chat already here that comes after a new chat's link refused past the limit, still under the lock:
 * it opens its chat after the unlock, and the refusal stays to be said. Cleared by it, the refused link was lost with no word.
 */
it("an invite link to a chat already here, opened after a refused one while locked, leaves the refusal said", async () => {
  const known = createChatInvite().inviteCode;
  const reading = readInvite(known);
  if (reading.ok) ensureSession(reading.keys);
  const codes = [createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode, createChatInvite().inviteCode];
  window.location.hash = `#${codes[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const code of [...codes.slice(1), known]) {
    window.location.hash = `#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(4));
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened");
}, 60_000);
