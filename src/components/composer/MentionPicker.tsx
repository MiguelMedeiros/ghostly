import { useCallback, useId, useMemo, useState, type KeyboardEvent, type MutableRefObject, type RefObject } from "react";
import { MENTION_EVERYONE, type GroupMention } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import {
  composeMentions, filterCandidates, insertMention, mentionLabel, mentionQueryAt,
  type ChosenMention, type MentionCandidate, type MentionQuery,
} from "../../lib/parse/mentions";

/** What a group gives its composer: the members to pick from, and whether "@everyone" is offered. */
export interface ComposerMentions { candidates: MentionCandidate[]; everyone?: boolean }

/**
 * The composer's "@": while the caret ends an "@…", a list of the group's members that fit (name and a piece of
 * their key) opens over the field. Arrows move, Enter or Tab choose, Escape closes it until the next "@"; a click
 * chooses too. The textarea keeps the focus throughout, and each choice is remembered with the
 * member's key, so the message names them even when two go by the same name.
 */
export function useMentionPicker({ mentions, text, setText, textareaRef, caretRef }: {
  mentions?: ComposerMentions;
  text: string;
  setText: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  caretRef: MutableRefObject<number | null>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<ChosenMention[]>([]);
  // Escape closes the list for the "@" it was open for; the next "@" opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);

  const everyone = useMemo<MentionCandidate[]>(() => mentions?.everyone ? [{ key: MENTION_EVERYONE, name: "everyone", tag: t("mentions.everyoneHint") }] : [], [mentions?.everyone, t]);
  const matches = useMemo(() => query && mentions ? filterCandidates([...mentions.candidates, ...everyone], query.query) : [], [query, mentions, everyone]);
  const open = !!query && query.start !== dismissed && matches.length > 0;

  /** Where the caret is now decides whether a list is open, and for what. */
  const onCaret = useCallback(() => {
    const input = textareaRef.current;
    if (!mentions || !input || input.selectionStart !== input.selectionEnd) { setQuery(null); return; }
    const next = mentionQueryAt(input.value, input.selectionStart);
    setQuery(prev => prev?.start === next?.start && prev?.query === next?.query && prev?.end === next?.end ? prev : next);
    if (!next || next.query !== query?.query) setActive(0);
    if (next?.start !== dismissed) setDismissed(null);
  }, [mentions, textareaRef, query?.query, dismissed]);

  const choose = (candidate: MentionCandidate) => {
    if (!query) return;
    const label = candidate.key === MENTION_EVERYONE ? "everyone" : mentionLabel(candidate.name);
    const next = insertMention(text, query, label);
    caretRef.current = next.caret;
    setText(next.text);
    setChosen(list => [...list, { key: candidate.key, label }]);
    setQuery(null);
    textareaRef.current?.focus({ preventScroll: true });
  };

  /** The composer's keys go here first: true when the list used them. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(i => (i + step + matches.length) % matches.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      choose(matches[Math.min(active, matches.length - 1)]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(query!.start);
      return true;
    }
    return false;
  };

  const optionId = (i: number) => `${id}-mention-${i}`;
  const current = Math.min(active, matches.length - 1);
  // The field stays a textbox (what finds it, finds it still); these tie it to the list while it is open.
  const inputProps = mentions ? {
    "aria-autocomplete": "list" as const,
    "aria-controls": open ? `${id}-mentions` : undefined,
    "aria-activedescendant": open ? optionId(current) : undefined,
  } : {};

  const element = open ? (
    <div id={`${id}-mentions`} role="listbox" aria-label={t("mentions.label")} data-testid="mention-picker"
      className="absolute bottom-full start-0 end-0 mb-2 z-40 max-h-72 overflow-y-auto rounded-xl border border-border bg-sidebar-bg py-1 shadow-xl animate-fade-in max-w-sm">
      {matches.map((c, i) => (
        <div key={c.key} id={optionId(i)} role="option" aria-selected={i === current} data-testid="mention-option" data-key={c.key}
          // The field keeps the focus: a press chooses without taking it.
          onMouseDown={e => e.preventDefault()} onClick={() => choose(c)} onMouseMove={() => setActive(i)}
          className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm ${i === current ? "bg-surface-hover" : ""}`}>
          <span className="truncate font-medium text-text-primary">{c.key === MENTION_EVERYONE ? "@everyone" : c.name}</span>
          <span className="ms-auto shrink-0 font-mono text-[11px] text-text-muted">{c.tag}</span>
        </div>
      ))}
    </div>
  ) : null;

  return {
    element,
    onCaret,
    onKeyDown,
    inputProps,
    /** The mentions of the text as it will be sent. */
    compose: (value: string): GroupMention[] => mentions ? composeMentions(value, chosen) : [],
    /** After a send: nothing chosen any more. */
    reset: () => { setChosen([]); setQuery(null); },
  };
}
