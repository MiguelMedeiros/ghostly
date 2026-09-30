/**
 * Capabilities a paired session announces once it is ready (WISP 03, 401): what this app does on this
 * session beyond what the handshake offer carries. Apps before 0.5 accept at most 16 entries in the offer's
 * `capabilities`, and a full offer is already there, so these travel in one frame on the authenticated
 * session instead, the way `paired-payments` and `paired-groups` do:
 *
 *     {"t":"paired-capabilities","c":["calls/1","services/1","files/3","typing/1","react/1","edit/1"]}
 *
 * Each side sends it on every ready session, and again whenever what it offers changes. Something is on
 * only while both sides list it; a peer that never sends the frame (an older app) offers nothing here.
 * The frame carries no message id, so older apps drop it.
 */

/** Voice and video calls: `paired-call` signals on this session, media on a WebRTC connection of its own (WISP 601). */
export const CALLS_CAPABILITY = "calls/1";
/** Shared local web apps: `paired-services` and `ph` HTTP frames on this session (WISP 701). */
export const SERVICES_CAPABILITY = "services/1";

/**
 * Files of any size (WISP 501 rev 0.3): offered and accepted, many chunks in flight, resumed from the last
 * confirmed byte, checked by digest (`pf-offer` … frames, `chatFiles.ts`). Without it, files/2 and 100 MiB.
 */
export const FILES_CAPABILITY = "files/3";

/** The typing indicator: `paired-typing` frames on this session, 1:1 chats only (WISP 401 § Typing, `pairedTyping.ts`). */
export const TYPING_CAPABILITY = "typing/1";

/** Reactions to messages: `paired-reaction` frames on this session, 1:1 chats only (WISP 401 § Reactions, `reactions.ts`). */
export const REACTIONS_CAPABILITY = "react/1";

/** Editing sent texts: `paired-edit` frames on this session, 1:1 chats only (WISP 401 § Edits, `pairedEdits.ts`). */
export const EDIT_CAPABILITY = "edit/1";

/** Wake-up push: `paired-wake` frames on this session, 1:1 chats only (WISP 401 § Wake-up push, `pairedWake.ts`). */
export const WAKE_SESSION_CAPABILITY = "wake/1";

/** A pinned message: `paired-pin` frames on this session, 1:1 chats only (WISP 401 § Pinned message, `pins.ts`). */
export const PIN_CAPABILITY = "pin/1";

/**
 * Status cards: this app shows a message's card (`sc`) and takes a card message's edits past the text's 100, which an
 * older app would drop (WISP 4xx · Status Cards, `statusCards.ts`). A card itself needs nothing: older apps show its text.
 */
export const STATUS_CARD_CAPABILITY = "status-card/1";

/**
 * Message buttons: this app shows a message's buttons (a card of kind `buttons`) and presses them with a reply naming
 * the button (WISP 4xx · Message Buttons). Nothing is gated on it: an older app shows the text and sends replies, and
 * a press reads as an ordinary reply there. It tells a bot whether its contact can press at all.
 */
export const BUTTONS_CAPABILITY = "buttons/1";

export type SessionCapability = typeof CALLS_CAPABILITY | typeof SERVICES_CAPABILITY | typeof FILES_CAPABILITY | typeof TYPING_CAPABILITY | typeof REACTIONS_CAPABILITY | typeof EDIT_CAPABILITY | typeof WAKE_SESSION_CAPABILITY | typeof PIN_CAPABILITY | typeof STATUS_CARD_CAPABILITY | typeof BUTTONS_CAPABILITY;

/** Every capability this app knows on a session: what `receive` reports changes of. */
export const KNOWN_SESSION_CAPABILITIES: readonly SessionCapability[] = [CALLS_CAPABILITY, SERVICES_CAPABILITY, FILES_CAPABILITY, TYPING_CAPABILITY, REACTIONS_CAPABILITY, EDIT_CAPABILITY, WAKE_SESSION_CAPABILITY, PIN_CAPABILITY, STATUS_CARD_CAPABILITY, BUTTONS_CAPABILITY];

export const SESSION_CAPABILITIES_FRAME = "paired-capabilities";

const MAX_ENTRIES = 32;
const IDENTIFIER = /^[a-z0-9/-]{1,40}$/;

/** The frame that says what this side offers. */
export function sessionCapabilitiesFrame(offered: readonly SessionCapability[]): { t: typeof SESSION_CAPABILITIES_FRAME; c: string[] } {
  return { t: SESSION_CAPABILITIES_FRAME, c: [...new Set(offered)] };
}

/**
 * The capabilities a `paired-capabilities` frame lists, or null when it is malformed (then it says nothing,
 * and what the peer said before stands). Identifiers this app does not know are kept: they grant nothing,
 * since only what both sides list is on.
 */
export function parseSessionCapabilities(frame: Record<string, unknown>): Set<string> | null {
  const list = frame.c;
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) return null;
  if (!list.every((entry): entry is string => typeof entry === "string" && IDENTIFIER.test(entry))) return null;
  return new Set(list);
}

/** What both sides of one session offer. Reset when the session goes. */
export class SessionCapabilities {
  private peer: Set<string> | null = null;

  constructor(private readonly offered: () => readonly SessionCapability[]) {}

  /** The frame to send now: on every ready session, and after what this side offers changed. */
  announcement() { return sessionCapabilitiesFrame(this.offered()); }

  /** This side offers it (whatever the peer says). */
  offers(capability: SessionCapability): boolean { return this.offered().includes(capability); }

  /** The peer listed it on this session. False until the peer says anything. */
  peerOffers(capability: SessionCapability): boolean { return !!this.peer?.has(capability); }

  /** The peer has said what it offers on this session. */
  get peerAnnounced(): boolean { return this.peer !== null; }

  /** Both sides offer it on this session. */
  agreed(capability: SessionCapability): boolean { return this.offers(capability) && this.peerOffers(capability); }

  /**
   * A `paired-capabilities` frame from the peer. Returns the capabilities whose agreement changed, or null
   * when the frame was malformed and ignored.
   */
  receive(frame: Record<string, unknown>, known: readonly SessionCapability[] = KNOWN_SESSION_CAPABILITIES): SessionCapability[] | null {
    const parsed = parseSessionCapabilities(frame);
    if (!parsed) return null;
    const before = known.map(capability => this.agreed(capability));
    this.peer = parsed;
    return known.filter((capability, index) => this.agreed(capability) !== before[index]);
  }

  /** The session ended: nothing is agreed until the next one says so. */
  reset(): void { this.peer = null; }
}
