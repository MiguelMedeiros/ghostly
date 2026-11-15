import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import { bech32m } from "@scure/base";
import { createChatInvite, createIdentity, createLink, encodeCommunityLink, encodeGroupEntryLink, encodeInviteCode, groupEntryUrl, inviteLink, inviteQrSegments, INVITE_MAX_LENGTH } from "@ghostly/core";
import type { ClipboardFile } from "@ghostly/browser/host";
import { JoinDialog } from "../../components/JoinDialog";
import { onJoinNotice, type JoinNoticeKey } from "../../lib/joinNotice";
import { followPlatformDrags, guardFileDrops, resetPlatformDrags } from "../../lib/pastedFiles";
import { ensureSession, listSessions, setStorageProfile } from "../../lib/storage";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** What the QR decoder finds in the picture it is handed: happy-dom draws nothing, so the test says (none, unless set). */
const qr = vi.hoisted(() => ({ data: null as string | null, calls: 0 }));
vi.mock("jsqr", () => ({ default: () => { qr.calls++; return qr.data === null ? null : { data: qr.data }; } }));

// covers: invite.invalid, invite.code
describe("Join and a ghostly1 invite", () => {
  const { invite, inviteCode } = createChatInvite();
  const words = bech32m.decode(inviteCode, INVITE_MAX_LENGTH).words.slice(1);
  const withWords = (all: number[]) => bech32m.encode("ghostly", all, false);

  /** Opens the field (a failed paste does), types `value` into it and submits. */
  async function submit(value: string) {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => value);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    return { onJoin, alert: () => screen.queryByRole("alert") };
  }

  describe("Join reads a ghostly1 invite however it arrives", () => {
    it.each([
      ["the link", inviteLink(inviteCode)],
      ["the link on app.ghostly.tools", inviteLink(inviteCode, "https://app.ghostly.tools")],
      ["the bare code", inviteCode],
      ["the code in capitals, as a QR holds it", inviteQrSegments(inviteCode).join("")],
    ])("%s", async (_, value) => {
      const { onJoin, alert } = await submit(value);
      expect(onJoin).toHaveBeenCalledTimes(1);
      expect(onJoin.mock.calls[0][0]).toEqual({ profile: "paired-chat/1", seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32,
        encKeyB64: invite.encKeyB64, peerParticipationKeyB64: invite.peerParticipationKeyZ32, deliveryMode: undefined });
      expect(alert()).toBeNull();
    });

    it("still reads an older pair1/ code", async () => {
      const older = encodeInviteCode({ ...createLink().invite, profile: "paired-chat/1" });
      const { onJoin } = await submit(older);
      expect(onJoin.mock.calls[0][0]).toMatchObject({ profile: "paired-chat/1" });
    });
  });

  describe("Join says why it refuses a code, and joins nothing", () => {
    const typo = inviteCode.slice(0, 50) + (inviteCode[50] === "q" ? "p" : "q") + inviteCode.slice(51);
    it.each([
      ["a typo", typo, "This code has a typo. Check it, or ask for the code again."],
      ["a newer version", withWords([3, ...words]), "This invite was made by a newer Ghostly. Update to join."],
      // Version 2 adds a device to a profile (WISP 06): no chat is made of it, and the person is told where it goes.
      ["a code that adds a device", withWords([2, ...words]), "This code adds a device to a profile. On the new device, choose I already use Ghostly."],
      ["version 0", withWords([0, ...words]), "This is not a Ghostly invite."],
      ["another kind of code", "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "This is not a Ghostly invite."],
      ["a damaged invite", withWords([1, ...bech32m.toWords(bech32m.fromWords(words).slice(0, 96))]), "This invite is damaged. Ask for a new one."],
    ])("%s", async (_, value, message) => {
      const { onJoin, alert } = await submit(inviteLink(value));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(alert()).toHaveTextContent(message);
      expect(onJoin).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Invite code" })).toBeInTheDocument();
    });

    it("in another language too", async () => {
      const onJoin = vi.fn();
      const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />, { language: "pt" });
      engine.readClipboardText = vi.fn(async () => withWords([3, ...words]));
      await user.click(screen.getByRole("button", { name: "Colar da área de transferência" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Este convite foi criado por um Ghostly mais novo. Atualize para entrar.");
    });
  });
});

// covers: invite.own, invite.rejoin
describe("Join and an invite this profile made or joined", () => {
  /** A chat this profile made, as New makes it: the inviter's keys and its code kept with the session. */
  function ownChat() {
    const { mine, inviteCode } = createChatInvite();
    const id = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1", participationSeedB64: mine.participationSeedB64 }, { inviteCode });
    return { id, inviteCode };
  }

  async function submit(value: string, language?: "pt") {
    const onJoin = vi.fn(), onOpenChat = vi.fn(), onClose = vi.fn();
    const notices: JoinNoticeKey[] = [];
    onJoinNotice((key) => notices.push(key));
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onOpenChat={onOpenChat} onClose={onClose} />, { language });
    engine.readClipboardText = vi.fn(async () => value);
    await user.click(screen.getByRole("button", { name: language === "pt" ? "Colar da área de transferência" : "Paste from clipboard" }));
    return { user, engine, onJoin, onOpenChat, onClose, notices };
  }

  describe("Join refuses this profile's own invite and offers the chat that owns it", () => {
    it.each([
      ["the link", (code: string) => inviteLink(code)],
      ["the bare code", (code: string) => code],
      ["the code in capitals, as a QR holds it", (code: string) => inviteQrSegments(code).join("")],
    ])("%s", async (_, form) => {
      const { id, inviteCode } = ownChat();
      const { user, onJoin, onOpenChat, notices } = await submit(form(inviteCode));
      expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite. Share it with a contact; they join with it.");
      expect(screen.queryByRole("textbox", { name: "Invite code" })).toBeNull();
      expect(onJoin).not.toHaveBeenCalled();
      expect(listSessions()).toHaveLength(1);
      await user.click(screen.getByTestId("join-open-chat"));
      expect(onOpenChat).toHaveBeenCalledWith(id);
      expect(notices).toEqual([]);
    });

    it("a chat made before ghostly1 owns its older code too", async () => {
      const older = createLink();
      const inviteCode = encodeInviteCode({ ...older.invite, profile: "paired-chat/1" });
      const id = ensureSession({ seedB64: older.mine.seedB64, peerPubKeyB64: older.mine.peerPubKeyZ32, encKeyB64: older.mine.encKeyB64, profile: "paired-chat/1" }, { inviteCode });
      const { user, onJoin, onOpenChat } = await submit(inviteCode);
      expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite.");
      await user.click(screen.getByTestId("join-open-chat"));
      expect(onOpenChat).toHaveBeenCalledWith(id);
      expect(onJoin).not.toHaveBeenCalled();
    });

    it("in another language too", async () => {
      const { inviteCode } = ownChat();
      await submit(inviteCode, "pt");
      expect(await screen.findByRole("alert")).toHaveTextContent("Este convite é seu. Compartilhe com um contato; é ele quem entra com ele.");
      expect(screen.getByTestId("join-open-chat")).toHaveTextContent("Abrir essa conversa");
    });

    it("a second paste clears it: someone else's invite then joins", async () => {
      const { inviteCode } = ownChat();
      const { user, engine, onJoin } = await submit(inviteCode);
      expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite.");
      const theirs = createChatInvite();
      engine.readClipboardText = vi.fn(async () => theirs.inviteCode);
      await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      expect(screen.queryByTestId("join-own-invite")).toBeNull();
      expect(onJoin).toHaveBeenCalledTimes(1);
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: theirs.invite.seedB64 });
    });
  });

  describe("an invite this profile already joined by opens that chat", () => {
    it("says so, and makes no second chat", async () => {
      const { invite, inviteCode } = createChatInvite();
      const id = ensureSession({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64, profile: "paired-chat/1", peerParticipationKeyB64: invite.peerParticipationKeyZ32 });
      const { onJoin, onOpenChat, notices } = await submit(inviteLink(inviteCode));
      expect(onOpenChat).toHaveBeenCalledWith(id);
      expect(onJoin).not.toHaveBeenCalled();
      expect(notices).toEqual(["join.alreadyIn"]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(listSessions()).toHaveLength(1);
    });
  });

  describe("another profile on the same app", () => {
    it("may join this profile's invite: its chats are its own", async () => {
      const { inviteCode } = ownChat();
      setStorageProfile("work12345a");
      try {
        const { onJoin, onOpenChat } = await submit(inviteCode);
        expect(onJoin).toHaveBeenCalledTimes(1);
        expect(onOpenChat).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
      } finally { setStorageProfile(""); }
    });
  });
});

// covers: invite.clipboard
/**
 * Join → Paste from clipboard (apps/ui/src/components/JoinDialog.tsx). The desktop host reads natively, so
 * WKWebView's "Paste" callout never asks for a second click; when reading fails the invite field
 * opens focused with the keys to press.
 */
describe("Paste from clipboard in Join", () => {
  /** The page's Clipboard API; set after rendering, since user-event's setup() installs a stub of its own. */
  function pageClipboard(readText: () => Promise<string>) {
    const read = vi.fn(readText);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: read } });
    return read;
  }

  afterEach(() => { Reflect.deleteProperty(navigator, "clipboard"); });

  it("joins in one click through the desktop host, without the page's Clipboard API", async () => {
    const { invite } = createLink();
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    const web = pageClipboard(async () => "not this one");
    engine.readClipboardText = vi.fn(async () => `  ${encodeInviteCode(invite)}\n`);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64 });
    expect(engine.readClipboardText).toHaveBeenCalledTimes(1);
    expect(web).not.toHaveBeenCalled();
  });

  it("a refused read opens the field, focused, with the keys to press", async () => {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    pageClipboard(async () => "not this one");
    engine.readClipboardText = async () => { throw new Error("Not allowed from this window"); };
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Press (⌘V|Ctrl\+V) to paste the invite below\.$/);
    expect(screen.getByRole("textbox", { name: "Invite code" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Paste from clipboard" })).not.toHaveAttribute("aria-busy");
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("adding this device: the field, its hints and its button speak of the code, not of an invite or a chat", async () => {
    const onDevice = vi.fn(async () => {});
    const { user, engine } = renderApp(<JoinDialog onDevice={onDevice} onClose={() => {}} />);
    engine.readClipboardText = async () => { throw new Error("Not allowed from this window"); };
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Press (⌘V|Ctrl\+V) to paste the code below\.$/);
    const field = screen.getByRole("textbox", { name: "Code from your other device" });
    expect(field).toHaveAttribute("placeholder", "Paste the code…");
    expect(screen.getByRole("button", { name: "Add this device" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join chat" })).toBeNull();
    engine.readClipboardText = async () => "  ";
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Clipboard is empty\. Copy the code from your other device, then press (⌘V|Ctrl\+V) below\.$/));
    expect(onDevice).not.toHaveBeenCalled();
  });

  it("on the web, a denied Clipboard API does the same, and an empty one says so", async () => {
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    pageClipboard(async () => { throw new DOMException("denied", "NotAllowedError"); });
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Press/);
    pageClipboard(async () => "  ");
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Clipboard is empty\. Copy an invite, then press (⌘V|Ctrl\+V) below\.$/));
  });

  it("on a phone, names no keys: the field pastes with a long press", async () => {
    // A touch screen with no mouse (`any-pointer` coarse, never fine), whatever the platform string says.
    const matchMedia = window.matchMedia.bind(window);
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(any-pointer: coarse)" || query === "(any-pointer: fine)"
        ? ({ ...matchMedia(query), matches: query === "(any-pointer: coarse)" } as MediaQueryList)
        : matchMedia(query));
    try {
      const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      pageClipboard(async () => { throw new DOMException("denied", "NotAllowedError"); });
      await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Touch and hold the field below, then tap Paste\.$/);
      pageClipboard(async () => "  ");
      await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Clipboard is empty\. Copy an invite, then paste it below\.$/));
      expect(screen.getByRole("alert").textContent).not.toMatch(/⌘|Ctrl/);
    } finally { media.mockRestore(); }
  });
});

// covers: invite.invalid, groups.protocol.entry
describe("Join reads a link copied with the sentence around it", () => {
  // agents#1631, #1632: a link copied with the sentence around it, pasted in Join.
  const group = encodeGroupEntryLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
  const groupUrl = groupEntryUrl("https://ghostly.tools", { g: "AbCdEfGhIjKlMnOpQrStUv", host: group.split("/")[2] });
  const community = encodeCommunityLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
  const { inviteCode } = createChatInvite();

  async function paste(value: string) {
    const onJoin = vi.fn();
    const onJoinGroup = vi.fn(async () => {});
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onJoinGroup={onJoinGroup} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => value);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    return { onJoin, onJoinGroup, alert: () => screen.queryByRole("alert") };
  }

  it.each([
    ["a group's link with a full stop", `Join our group: ${groupUrl}.`],
    ["a group's link in parentheses", `(${groupUrl})`],
    ["a group's link before a !", `Join us: ${groupUrl}!`],
    ["a group's link in < >", `<${groupUrl}>`],
    ["a community's link with a full stop", `${community}.`],
  ])("%s joins", async (_, value) => {
    const { onJoinGroup, onJoin, alert } = await paste(value);
    expect(onJoinGroup).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    expect(alert()).toBeNull();
  });

  it.each([
    ["in quotes", `"${inviteCode}"`],
    ["in « »", `« ${inviteCode} »`],
    ["in < >", `Here: <${inviteCode}>.`],
    ["before a ?", `${inviteCode}?`],
    ["in [ ]", `[${inviteCode}]`],
  ])("a chat invite %s joins", async (_, value) => {
    const { onJoin, alert } = await paste(value);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(alert()).toBeNull();
  });

  it("a group's link with a character lost is said as a group link that does not work, with what to do", async () => {
    const broken = groupUrl.slice(0, 50) + groupUrl.slice(51);
    const { onJoinGroup, onJoin } = await paste(`Join our group: ${broken}.`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This link to a group does not work");
    expect(alert).toHaveTextContent("Ask for the link again");
    expect(alert).not.toHaveTextContent("This is not a Ghostly invite.");
    expect(onJoinGroup).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });
});

// covers: invite.invalid
/**
 * A refused paste (JoinDialog.tsx) says what is wrong and asks to check the code: the field that opens holds what was
 * pasted, caret at its end, marked invalid and described by the error, so the check can be made in place.
 */
describe("Join keeps a refused paste in the field", () => {
  const link = inviteLink(createChatInvite().inviteCode);

  it.each([
    ["not an invite", "hello there", "This is not a Ghostly invite."],
    ["a damaged invite", "https://example.com/#/join/abc", "This invite is damaged. Ask for a new one."],
    ["half an invite link", link.slice(0, Math.floor(link.length / 2)), "This code has a typo. Check it, or ask for the code again."],
  ])("%s", async (_, value, message) => {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => `  ${value}\n`);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Invite code" });
    expect(field).toHaveValue(value);
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([value.length, value.length]);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(message);
    expect(onJoin).not.toHaveBeenCalled();
    // Fixed in place: the error goes, and the field is no longer marked.
    await user.type(field, "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("a second refused paste, the field already open, replaces its text and takes the focus back", async () => {
    const { user, engine } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => "hello there");
    const paste = screen.getByRole("button", { name: "Paste from clipboard" });
    await user.click(paste);
    await screen.findByRole("alert");
    engine.readClipboardText = vi.fn(async () => "https://example.com/#/join/abc");
    await user.click(paste);
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite is damaged. Ask for a new one.");
    const field = screen.getByRole("textbox", { name: "Invite code" });
    expect(field).toHaveValue("https://example.com/#/join/abc");
    expect(field).toHaveFocus();
  });

  it("an unreadable clipboard leaves the field empty, described by the error but not marked invalid", async () => {
    const { user, engine } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    engine.readClipboardText = async () => { throw new Error("Not allowed from this window"); };
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await screen.findByRole("alert");
    const field = screen.getByRole("textbox", { name: "Invite code" });
    expect(field).toHaveValue("");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).toHaveAccessibleDescription(/^Could not read the clipboard\./);
  });
});

// covers: invite.qr.camera
/**
 * Join's Scan and the camera's Cancel take each other's place (apps/ui/src/components/JoinDialog.tsx): the key that
 * pressed one lands on the other, as on a wallet's Send (SendScan), never on the page behind the dialog.
 */
describe("Join's Scan and Cancel by keyboard", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("Scan hands the focus to the camera's Cancel while the camera starts, and Cancel back to Scan", async () => {
    // A camera that is still being asked for: Join shows Cancel in place of Scan meanwhile.
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(() => new Promise(() => {})) } });
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    screen.getByRole("button", { name: "Scan QR", hidden: true }).focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByRole("button", { name: "Cancel", hidden: true });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR", hidden: true })).toHaveFocus());
  });

  it("with the camera on, Cancel gives the focus back to Scan", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
    // The preview never plays: the decoder is not reached, the camera stays on until Cancel.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    screen.getByRole("button", { name: "Scan QR", hidden: true }).focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByRole("button", { name: "Cancel", hidden: true });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR", hidden: true })).toHaveFocus());
    expect(track.stop).toHaveBeenCalled();
  });
});

// covers: invite.qr.camera
/**
 * Join's camera scan (apps/ui/src/components/JoinDialog.tsx, lib/qrReader.ts `scanQrFrames`) when the camera ends under
 * it: on Android the system closes it a few seconds after the app goes to Home, and the video keeps its last frame.
 */
describe("Join's camera scan when the camera ends", () => {
  /** The camera's one track, as the system ends it (Android takes the camera from an app at Home). */
  const track = { readyState: "live" as MediaStreamTrackState, stop() { this.readyState = "ended"; } };
  const camera = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;

  const getContext = HTMLCanvasElement.prototype.getContext;
  const play = HTMLMediaElement.prototype.play;
  beforeEach(() => {
    qr.data = null; qr.calls = 0;
    track.readyState = "live";
    // No worker here: frames are decoded on the page.
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers"); } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => camera } });
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) })) as unknown as typeof getContext;
    HTMLMediaElement.prototype.play = async () => {};
    for (const [name, value] of [["readyState", 4], ["videoWidth", 64], ["videoHeight", 64]] as const) {
      Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, get: () => value });
    }
    // happy-dom's preview takes only its own streams: this one holds the stand-in camera.
    let source: MediaStream | null = null;
    Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, get: () => source, set: (stream: MediaStream | null) => { source = stream; } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    HTMLCanvasElement.prototype.getContext = getContext;
    HTMLMediaElement.prototype.play = play;
    for (const name of ["readyState", "videoWidth", "videoHeight", "srcObject"]) delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[name];
  });

  it("stops reading the last frame and says the camera is unavailable", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
    await waitFor(() => expect(qr.calls).toBeGreaterThan(0));
    act(() => { track.readyState = "ended"; });
    expect(await screen.findByText("Camera unavailable. Paste an invite or open an image.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan QR" })).toBeTruthy();
    // No frame read after it ended: the one the video still shows is not a camera's.
    const after = qr.calls;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(qr.calls).toBe(after);
  });
});

// covers: invite.qr.image
/**
 * Join takes a screenshot of an invite's QR pasted or dropped on it (apps/ui/src/components/JoinDialog.tsx): read as
 * "Open image" reads one, and what it holds is only parsed as an invite.
 */
describe("A QR screenshot pasted or dropped on Join", () => {
  /** What a clipboard or a drag hands the page: happy-dom has no DataTransfer to build one with. */
  function transfer({ files = [], text = "", html = "", types = [] }: { files?: File[]; text?: string; html?: string; types?: string[] }) {
    return {
      files, types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : []), ...types],
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "",
      dropEffect: "none",
    };
  }
  /** A 400 x 400 PNG's header: a picture is decoded only once its header says its size. */
  const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 144, 0, 0, 1, 144, 8, 6, 0, 0, 0];
  const png = (name = "Screenshot.png") => new File([new Uint8Array(PNG)], name, { type: "image/png" });
  const dialog = () => screen.getByRole("dialog", { hidden: true });

  const getContext = HTMLCanvasElement.prototype.getContext;
  beforeEach(() => {
    qr.data = null; qr.calls = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close() {} })));
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) })) as unknown as typeof getContext;
  });
  afterEach(() => { vi.unstubAllGlobals(); HTMLCanvasElement.prototype.getContext = getContext; });

  it("a pasted image is decoded and joins, as a pasted invite does", async () => {
    const { invite } = createLink();
    qr.data = encodeInviteCode(invite);
    const onJoin = vi.fn();
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    const left = fireEvent.paste(screen.getByRole("button", { name: "Paste from clipboard" }), { clipboardData: transfer({ files: [png()] }) });
    expect(left).toBe(false);
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("a QR that holds a web address is refused, never opened", async () => {
    qr.data = "https://example.com/#not-an-invite";
    const onJoin = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const before = location.href;
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png()] }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("This is not a Ghostly invite.");
    expect(onJoin).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(location.href).toBe(before);
    open.mockRestore();
  });

  it("a picture with no QR says so", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png()] }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("No QR found. Try a clearer image.");
  });

  it("text, and a rich copy with a picture of itself, are left to the field", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ text: "ghostly1…" }) })).toBe(true);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png("image.png")], text: "a cell", html: "<td>a cell</td>" }) })).toBe(true);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ files: [new File(["%PDF"], "a.pdf", { type: "application/pdf" })] }) })).toBe(true);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(qr.calls).toBe(0);
  });

  describe("where the webview shows the page nothing of a copied picture (Desktop on Linux)", () => {
    /** What the desktop host holds for a paste, read back by token as Rust hands it. */
    const held = (name: string | null, size: number, mime: string | null = null, head = PNG) =>
      ({ name, size, mime, read: vi.fn(async (offset: number, length: number) => { const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset))); bytes.set(head.slice(offset, offset + bytes.length)); return bytes; }), done: vi.fn<() => void>() }) satisfies ClipboardFile;
    /** A PNG header saying `width` x `height`. */
    const sized = (width: number, height: number) => [...PNG.slice(0, 16), ...[width, height].flatMap((n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), ...PNG.slice(24)];
    afterEach(() => { fakeEngine.readClipboardFiles = undefined; });

    it("the app reads the picture, and its QR joins", async () => {
      const { invite } = createLink();
      qr.data = encodeInviteCode(invite);
      const shot = held(null, PNG.length, "image/png");
      fakeEngine.readClipboardFiles = vi.fn(async () => [shot]);
      const onJoin = vi.fn();
      renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(false);
      await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      expect(shot.done).toHaveBeenCalledTimes(1);
    });

    it("a QR copied in a web browser (Copy image: its HTML and address, no picture for the page) is read by the app", async () => {
      const { invite } = createLink();
      qr.data = encodeInviteCode(invite);
      fakeEngine.readClipboardFiles = vi.fn(async () => [held(null, PNG.length, "image/png")]);
      const onJoin = vi.fn();
      renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      const html = `<meta charset="utf-8"><img src="https://example.com/qr.png">`;
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({ html, text: "https://example.com/qr.png" }) })).toBe(false);
      await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
      // A rich copy with words beside its picture is text.
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({ html: `<p>scan me</p>${html}`, text: "scan me" }) })).toBe(true);
      expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1);
    });

    it("a picture copied as a file is read too, alone; a picture too large is not read, and says so", async () => {
      const notes = held("notes.pdf", 9), code = held("invite.PNG", PNG.length);
      fakeEngine.readClipboardFiles = vi.fn(async () => [notes, code]);
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      expect(await screen.findByRole("alert")).toHaveTextContent("No QR found. Try a clearer image.");
      expect(notes.read).not.toHaveBeenCalled();
      expect(notes.done).toHaveBeenCalledTimes(1);
      expect(code.done).toHaveBeenCalledTimes(1);

      const huge = held("photo.png", 12 * 1024 * 1024 + 1);
      fakeEngine.readClipboardFiles = vi.fn(async () => [huge]);
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Choose an image smaller than 12 MB."));
      expect(huge.read).not.toHaveBeenCalled();
      expect(huge.done).toHaveBeenCalledTimes(1);
    });

    it("a picture the app made a PNG of is judged by its pixels, not by how many bytes its PNG came to", async () => {
      // A 12 MP phone photo of a QR: 14 MB once the app packs it as a PNG, while the same picture as a JPEG reads.
      const { invite } = createLink();
      qr.data = encodeInviteCode(invite);
      const onJoin = vi.fn();
      renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      // Past what a picture may have to be decoded here, only its header is read, and the words fit a paste.
      const vast = held(null, 9_000_000, "image/png", sized(10_000, 6_000));
      fakeEngine.readClipboardFiles = vi.fn(async () => [vast]);
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That picture is too large to read. Paste a smaller one, or a screenshot of the QR."));
      expect(vast.read).toHaveBeenCalledTimes(1);
      expect(vast.read.mock.calls[0][0]).toBe(0);
      expect(vast.done).toHaveBeenCalledTimes(1);
      expect(createImageBitmap).not.toHaveBeenCalled();

      const photo = held(null, 13_985_607, "image/png", sized(4032, 3024));
      fakeEngine.readClipboardFiles = vi.fn(async () => [photo]);
      await waitFor(() => expect(screen.getByRole("button", { name: "Paste from clipboard" })).not.toHaveAttribute("aria-busy"));
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
      expect(photo.done).toHaveBeenCalledTimes(1);
    });

    it("copied files with no picture among them say so; an empty clipboard, and what the app refuses, are told apart", async () => {
      fakeEngine.readClipboardFiles = vi.fn(async () => []);
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(false);
      await waitFor(() => expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "Paste from clipboard" })).not.toHaveAttribute("aria-busy"));
      expect(screen.queryByRole("alert")).toBeNull();

      fakeEngine.readClipboardFiles = vi.fn(async () => [held("a.pdf", 4)]);
      fireEvent.paste(dialog(), { clipboardData: transfer({ types: ["text/uri-list"] }) });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");

      // What the app refuses is said in the dialog's own words: the composer's point at its +, which Join has none of.
      fakeEngine.readClipboardFiles = vi.fn(async () => { throw "That picture is too large to paste"; });
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That picture is too large to read. Paste a smaller one, or a screenshot of the QR."));
      fakeEngine.readClipboardFiles = vi.fn(async () => { throw "The clipboard's picture is damaged"; });
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG."));
      expect(createImageBitmap).not.toHaveBeenCalled();
    });

    describe("a picture dragged in from a file manager, which the webview names by address only", () => {
      /** A file manager's drag as WebKitGTK shows it to the page: no File, no text. */
      const named = () => ({ dataTransfer: transfer({ types: ["text/uri-list", "text/html"] }) });
      let read: ReturnType<typeof vi.fn<() => Promise<ClipboardFile[]>>>;
      let over: (on: boolean) => void;
      let unguard: () => void;
      beforeEach(() => { read = vi.fn(async () => []); over = followPlatformDrags(read); unguard = guardFileDrops(window); });
      afterEach(() => { unguard(); resetPlatformDrags(); });

      it("is taken as a drop, and the app reads the picture alone: its QR joins", async () => {
        const { invite } = createLink();
        qr.data = encodeInviteCode(invite);
        const notes = held("notes.pdf", 9), code = held("invite.png", PNG.length);
        read.mockResolvedValue([notes, code]);
        const onJoin = vi.fn();
        renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
        act(() => over(true));
        // Taken where it is over the dialog, not refused as the page refuses another app's files elsewhere.
        const moved = createEvent.dragOver(dialog(), named());
        fireEvent(dialog(), moved);
        expect(moved.defaultPrevented).toBe(true);
        expect((moved as DragEvent).dataTransfer?.dropEffect).toBe("copy");
        expect(fireEvent.drop(dialog(), named())).toBe(false);
        await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
        expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
        expect(read).toHaveBeenCalledTimes(1);
        expect(notes.read).not.toHaveBeenCalled();
        expect([notes.done, code.done].map((done) => done.mock.calls.length)).toEqual([1, 1]);
      });

      it("dropped files with no picture among them, and a picture too large, say so unread", async () => {
        read.mockResolvedValueOnce([held("a.pdf", 4)]);
        renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
        act(() => over(true));
        expect(fireEvent.drop(dialog(), named())).toBe(false);
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");

        const huge = held("photo.png", 12 * 1024 * 1024 + 1);
        read.mockResolvedValueOnce([huge]);
        await waitFor(() => expect(screen.getByRole("button", { name: "Paste from clipboard" })).not.toHaveAttribute("aria-busy"));
        act(() => over(true));
        fireEvent.drop(dialog(), named());
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Choose an image smaller than 12 MB."));
        expect(huge.read).not.toHaveBeenCalled();
        expect(huge.done).toHaveBeenCalledTimes(1);
        expect(createImageBitmap).not.toHaveBeenCalled();
      });
    });

    it("Paste from clipboard with a picture there and no text (a screenshot of the QR) reads it, as Ctrl+V does", async () => {
      // On the real Linux app: "Clipboard is empty. Copy an invite, then press Ctrl+V below." while Ctrl+V on the
      // dialog read the same picture and joined.
      const { invite } = createLink();
      qr.data = encodeInviteCode(invite);
      fakeEngine.readClipboardText = vi.fn(async () => "");
      const shot = held(null, PNG.length, "image/png");
      fakeEngine.readClipboardFiles = vi.fn(async () => [shot]);
      const onJoin = vi.fn();
      const { unmount } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
      expect(shot.done).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();

      // Nothing there at all: still said as an empty clipboard.
      fakeEngine.readClipboardFiles = vi.fn(async () => []);
      renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard is empty. Copy an invite, then press Ctrl+V below.");
      expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("textbox", { name: "Invite code" })).toBeInTheDocument();
      fakeEngine.readClipboardText = undefined;
    });

    it("text never asks the app, and the web app has no such read", () => {
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(true);
      fakeEngine.readClipboardFiles = vi.fn(async () => []);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({ text: "ghostly1…" }) })).toBe(true);
      expect(fakeEngine.readClipboardFiles).not.toHaveBeenCalled();
    });
  });

  it("a dropped image joins; a dropped file of another kind is refused", async () => {
    const { invite } = createLink();
    qr.data = encodeInviteCode(invite);
    const onJoin = vi.fn();
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    expect(fireEvent.drop(dialog(), { dataTransfer: transfer({ files: [new File(["%PDF"], "a.pdf", { type: "application/pdf" })] }) })).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");
    expect(fireEvent.dragOver(dialog(), { dataTransfer: transfer({ files: [png()] }) })).toBe(false);
    expect(fireEvent.drop(dialog(), { dataTransfer: transfer({ files: [png()] }) })).toBe(false);
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
  });
});
