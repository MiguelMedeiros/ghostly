import type { TypingActivity, TypingKind } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { usePeerTypingActivity } from "../hooks/useTyping";
import { memberText } from "../lib/memberColors";

/** Three dots in a soft wave; still, and all shown, when motion is reduced (index.css `.typing-dots`). */
export function TypingDots() {
  return <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>;
}

const LABELS = { typing: "chat.typing", recording: "chat.typingRecording", thinking: "chat.typingThinking" } as const;

/**
 * "typing…", "recording audio…", "thinking…" or a bot's own status line where a chat says what its contact is doing
 * (WISP 401 § Typing): the header's subtitle and the chat list's preview line. Presence, not connection: it never
 * takes the connection icon's place. A status is plain text from the contact, already one short line (the engine
 * cleans it); it is isolated so its direction cannot turn the line around it.
 */
export function TypingText({ testId, activity, className = "" }: { testId: string; activity?: TypingActivity | null; className?: string }) {
  const { t } = useI18n();
  const kind = activity?.kind ?? "typing";
  return (
    <span data-testid={testId} data-kind={kind} className={`inline-flex min-w-0 items-center gap-1.5 text-accent ${className}`}>
      <TypingDots />
      {activity?.status
        ? <bdi data-testid={`${testId}-status`} className="truncate">{activity.status}</bdi>
        : <span className="truncate">{t(LABELS[kind] ?? LABELS.typing)}</span>}
    </span>
  );
}

const GROUP_LABELS = {
  typing: { one: "group.typing.one", two: "group.typing.two", many: "group.typing.many" },
  recording: { one: "group.typing.recordingOne", two: "group.typing.recordingTwo", many: "group.typing.recordingMany" },
  thinking: { one: "group.typing.thinkingOne", two: "group.typing.thinkingTwo", many: "group.typing.thinkingMany" },
} as const;

/** A member typing in a group, by the name the group shows them under; `key` gives their name their colour. */
export interface GroupTyper { name: string; key?: string; kind?: TypingKind; status?: string }

/** A typer's name, isolated, in their colour (lib/memberColors.ts) when their key is known. */
const TyperName = ({ typer }: { typer: GroupTyper }) =>
  <bdi data-testid="group-typing-name" data-key={typer.key} className={typer.key ? `font-medium ${memberText(typer.key)}` : undefined}>{typer.name}</bdi>;

/** Stand-ins for the names while the sentence is translated: the names go back in as elements of their own. */
const NAME = "\u0001", OTHER = "\u0002";

/** A translated sentence with `{name}` (and `{other}`) as elements: the words around them as the language puts them. */
function withNames(text: string, name: GroupTyper, other?: GroupTyper) {
  return text.split(new RegExp(`(${NAME}|${OTHER})`)).map((part, i) =>
    part === NAME ? <TyperName key={i} typer={name} /> : part === OTHER && other ? <TyperName key={i} typer={other} /> : part);
}

/**
 * Who is typing in a group (WISP 9xx · Group Mesh § Typing): "Ana is typing…", "Ana and Bo are typing…", "3 people are
 * typing…", and the same for recording and thinking when everyone does the same (plain typing otherwise). One member
 * with a status line shows it after their name, isolated as in a 1:1 chat.
 */
export function GroupTypingText({ testId, typers }: { testId: string; typers: readonly GroupTyper[] }) {
  const { t } = useI18n();
  const first = typers[0];
  const kind = typers.every(x => (x.kind ?? "typing") === (first?.kind ?? "typing")) ? first?.kind ?? "typing" : "typing";
  const labels = GROUP_LABELS[kind] ?? GROUP_LABELS.typing;
  const text = typers.length === 1 ? withNames(t(labels.one, { name: NAME }), first)
    : typers.length === 2 ? withNames(t(labels.two, { name: NAME, other: OTHER }), first, typers[1])
      : t(labels.many, { count: typers.length });
  return (
    <span data-testid={testId} data-kind={kind} data-count={typers.length} className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-accent">
      <TypingDots />
      {typers.length === 1 && first.status
        ? <span className="truncate"><TyperName typer={first} />: <bdi data-testid={`${testId}-status`}>{first.status}</bdi></span>
        : <span className="truncate">{text}</span>}
    </span>
  );
}

/**
 * The chat header's second line: the contact's key, or what the contact is doing while it lasts. `peerKey` only for a
 * paired 1:1 chat (the others never show typing). Everything about the connection stays in the icon beside the calls.
 */
export function ChatSubtitle({ peerKey, keyLabel }: { peerKey?: string; keyLabel: string }) {
  const activity = usePeerTypingActivity(peerKey);
  return (
    <p className={`m-0 truncate text-xs max-md:text-[10px] whitespace-nowrap ${activity ? "" : "text-text-muted/60 font-mono"}`} data-testid="chat-subtitle"
      role="status" aria-live="polite">
      {activity ? <TypingText testId="chat-typing" activity={activity} /> : keyLabel}
    </p>
  );
}
