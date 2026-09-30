import { Identicon } from "../Avatar";
import { useMemberText } from "../../contexts/MemberColorsContext";
import type { MessageAuthor } from "../../lib/senderRuns";

export type { MessageAuthor };

/** Who a member is at a glance, as `SenderAvatar` draws them: their picture, else their initial in their colour, else a pattern of their key. */
export type MemberFaceOf = Pick<MessageAuthor, "key" | "name" | "picture">;

/**
 * A member's face on its own, small (the Tasks panel's names, a folded row's sender): what `SenderAvatar` shows, for a
 * sighted reader only, as the name beside it says who it is.
 */
export function MemberFace({ face, size = 18, className = "" }: { face: MemberFaceOf; size?: number; className?: string }) {
  const memberText = useMemberText();
  return (
    <span aria-hidden="true" data-testid="member-face" data-key={face.key} style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-hover font-semibold leading-none select-none ${className}`}>
      {face.picture
        ? <img src={face.picture} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        : face.name ? <span className={memberText(face.key)}>{face.name.charAt(0).toUpperCase()}</span>
        : <Identicon seed={face.key} />}
    </span>
  );
}

/**
 * A member's picture beside their messages in a group, as WhatsApp and Telegram have it: once per run, on its last
 * bubble, with an empty place of the same width beside the others so the bubbles stay in line. Their picture; else
 * their initial in their colour; else, with no name, a pattern of their key. Only for a pointer or a finger: the name
 * above the message opens the same and is the button a keyboard or a screen reader reaches, so this one is hidden
 * from them and out of the tab order. Gone in a very narrow chat (index.css `.sender-avatar`), where the name's colour alone tells who wrote.
 */
export function SenderAvatar({ author, onOpen }: { author: MessageAuthor; onOpen?: () => void }) {
  const memberText = useMemberText();
  if (!author.last) return <span aria-hidden="true" data-testid="sender-avatar-spacer" className="sender-avatar" />;
  // A button out of the tab order (and out of the long press and the swipe, which leave buttons alone).
  return (
    <button type="button" tabIndex={-1} aria-hidden="true" data-testid="sender-avatar" data-key={author.key} onClick={onOpen}
      // The row's own double click opens the message's details: a tap here is only who wrote it.
      onDoubleClick={onOpen && (e => e.stopPropagation())}
      className={`sender-avatar relative flex items-center justify-center overflow-hidden rounded-full bg-surface-hover p-0 text-xs font-semibold select-none ${onOpen ? "cursor-pointer" : ""}`}>
      {author.picture
        ? <img src={author.picture} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        : author.name ? <span className={memberText(author.key)}>{author.name.charAt(0).toUpperCase()}</span>
        : <Identicon seed={author.key} />}
    </button>
  );
}
