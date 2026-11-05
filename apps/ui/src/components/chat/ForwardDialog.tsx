import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { FORWARD_MAX_TARGETS, forwardMessages, forwardSecret, type ForwardOutcome } from "../../lib/forward";
import type { SecretFinding } from "../../lib/parse/secrets";
import type { ChatMessage } from "../../lib/types";
import { SecretGuardDialog } from "../SecretGuardDialog";
import { ChatTargetRow, ChatTargetSearch } from "./ChatTargets";
import { chatTargetKeys, findChatTargets } from "../../lib/chatTargets";
import { useChatTargets, type ChatTarget } from "../../hooks/useChatTargets";
import { rawError } from "../../lib/errorText";
import { problemLine } from "../../lib/problemText";
import { listParts, listText } from "../../lib/listText";
import type { Translate } from "../../locales/translate";
import { useBackCloses } from "../../hooks/useDismiss";
import { SearchStatus } from "../ui/SearchStatus";

/**
 * "Forward to…" (WISP 400 § Forwards): the chats and groups to send messages on to, most recent first, found by name,
 * up to `FORWARD_MAX_TARGETS` of them, groups for files too (WISP 503). Text that looks like a seed or a key asks
 * first, as typing it would. Sent to one chat, that chat opens; what a chat refused is said here.
 */
export function ForwardDialog({ from, messages, onClose, onSent }: {
  /** The engine's id of the chat they are in: a link id, or `group:<id>`. */
  from: string;
  messages: readonly ChatMessage[];
  onClose(): void;
  /** Everything went: the selection this came from can end. */
  onSent?(): void;
}) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const targets = useChatTargets().filter(target => !!target.target);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ChatTarget[]>([]);
  const [secret, setSecret] = useState<SecretFinding | null>(null);
  const [busy, setBusy] = useState(false);
  useBackCloses(() => { if (!busy) onClose(); });
  const [problems, setProblems] = useState<{ name: string; partial?: string; error: string }[]>([]);
  /** The chats a send that others refused went to: out of the selection, so Send again does not send them it twice. */
  const [sentTo, setSentTo] = useState<string[]>([]);
  /**
   * What each chat that refused part of a forward got of it (the forwarded messages' ids): Send again sends it only the
   * rest, where it sent all of it again, and a group's 9th file on could never go (agents#1082).
   */
  const [got, setGot] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    search.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  const shown = useMemo(() => findChatTargets(targets, query), [targets, query]);
  const isChosen = (target: ChatTarget) => chosen.some(c => c.target === target.target);
  /** As many chosen as a forward takes: the other rows wait, and the line under the list says why. */
  const full = chosen.length >= FORWARD_MAX_TARGETS;
  const toggle = (target: ChatTarget) => setChosen(now => isChosen(target) ? now.filter(c => c.target !== target.target) : now.length >= FORWARD_MAX_TARGETS ? now : [...now, target]);

  const [sentBefore, sentAfter = ""] = t("chat.forward.sentTo").split("{{names}}");

  const send = async (confirmed = false) => {
    if (!chosen.length || busy) return;
    const found = confirmed ? null : forwardSecret(messages);
    if (found) { setSecret(found); return; }
    setBusy(true);
    setProblems([]);
    // Each chat what it did not get yet: the chats that are owed the same messages go in one call. One that got all of
    // it already (ticked again) is not called with nothing, which the engine refuses: it has it.
    const owed = new Map<string, { ids: string[]; to: string[] }>();
    const had: string[] = [];
    for (const c of chosen) {
      const ids = messages.map(m => m.id).filter(id => !got[c.target!]?.includes(id));
      if (!ids.length) { had.push(c.target!); continue; }
      const key = ids.join("\n");
      const call = owed.get(key) ?? owed.set(key, { ids, to: [] }).get(key)!;
      call.to.push(c.target!);
    }
    // A call refused whole does not hide what the others delivered: its chats say its refusal, the rest what they got.
    const calls = [...owed.values()];
    const settled = await Promise.allSettled(calls.map(call => forwardMessages(from, call.ids, call.to)));
    const outcome: ForwardOutcome[] = settled.flatMap((s, i) => s.status === "fulfilled" ? s.value
      : calls[i]!.to.map(to => ({ to, messageIds: [], sent: [], error: rawError(s.reason) })));
    setBusy(false);
    const gotNow = { ...got };
    for (const o of outcome) gotNow[o.to] = [...(gotNow[o.to] ?? []), ...(o.sent ?? [])];
    setGot(gotNow);
    // Any error is a failure, an empty one too: a chat whose error says nothing still got nothing. One that got part of
    // it says how much.
    const failed = outcome.filter(o => o.error !== null).map(o => {
      const name = chosen.find(c => c.target === o.to)?.name ?? "", part = gotNow[o.to]?.length ?? 0;
      const error = problemLine(o.error, t);
      return { name, partial: part ? ` (${t("chat.forward.partial", { sent: String(part), count: String(messages.length) })})` : "", error };
    });
    if (failed.length) {
      setProblems(failed);
      const went = chosen.filter(c => had.includes(c.target!) || outcome.some(o => o.to === c.target && o.error === null));
      setSentTo(now => [...now, ...went.map(c => c.name).filter(name => !now.includes(name))]);
      setChosen(now => now.filter(c => !went.includes(c)));
      return;
    }
    onSent?.();
    onClose();
    if (chosen.length === 1 && !sentTo.length) nav.conversation(chosen[0]!.path);
  };

  return createPortal(<dialog ref={dialog} data-testid="forward-dialog" aria-labelledby={`${id}-title`}
    // Not a cancel from the seed question over it (SecretGuardDialog): React hands it here too, and it is the question's.
    onCancel={(e) => { e.preventDefault(); if (!busy && e.target === e.currentTarget) onClose(); }}
    className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[min(640px,calc(100dvh_-_2rem))] flex-col rounded-2xl border border-border bg-sidebar-bg p-0 text-text-primary shadow-2xl backdrop:bg-black/60 open:flex">
    <div className="px-4 pt-4 pb-2 space-y-2">
      <h2 id={`${id}-title`} className="text-base font-semibold">{t("chat.forward.title")}</h2>
      {messages.length > 1 && <p className="m-0 text-xs text-text-muted" data-testid="forward-count">{t("chat.forward.messages", { count: String(messages.length) })}</p>}
      <ChatTargetSearch inputRef={search} list={list} testId="forward-search" value={query} onChange={setQuery} />
      <SearchStatus testId="forward-found" text={!query.trim() ? "" : shown.length ? t("chat.forward.found", { count: shown.length }) : t(targets.length ? "chat.forward.noMatch" : "chat.forward.noChats")} />
    </div>
    {/* As tall as its rows, shrinking and scrolling within the dialog's max height: `flex-1` (a basis of 0) in a
        dialog as tall as its content leaves WebKit a list of no height at all, with no chat to pick. */}
    <div className="min-h-0 flex-auto overflow-y-auto px-2">
      {shown.length === 0 ? (
        <p className="px-2 py-3 text-sm text-text-muted" data-testid="forward-none">{t(targets.length ? "chat.forward.noMatch" : "chat.forward.noChats")}</p>
      ) : (
        <ul ref={list} onKeyDown={chatTargetKeys(search)} className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-label={t("chat.forward.title")}>
          {shown.map(target => (
            <li key={target.chat}>
              <ChatTargetRow target={target} testId="forward-target" checked={isChosen(target)} onClick={() => toggle(target)}
                disabled={busy} unavailable={full && !isChosen(target)} describedBy={`${id}-limit`} />
            </li>
          ))}
        </ul>
      )}
    </div>
    {problems.length > 0 && (
      <ul className="m-0 mx-4 mt-2 list-none space-y-1 p-0" role="alert" data-testid="forward-error">
        {problems.map((p, i) => <li key={i} className="text-xs text-danger">{p.name ? <><bdi>{p.name}</bdi>{p.partial}: {p.error}</> : p.error}</li>)}
      </ul>
    )}
    {sentTo.length > 0 && <p className="m-0 mx-4 mt-1 line-clamp-2 break-words text-xs text-text-muted" data-testid="forward-sent"
      title={namesTitle(sentTo, t)}>{sentBefore}<NameList names={sentTo} />{sentAfter}</p>}
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="min-w-0 flex-1 text-xs text-text-muted">
        {/* Two lines at most, then cut: the whole list is in its title and read aloud (NameList). */}
        <p className="m-0 line-clamp-2 break-words" data-testid="forward-chosen" title={chosen.length ? namesTitle(chosen.map(c => c.name), t) : undefined}>
          {chosen.length ? <NameList names={chosen.map(c => c.name)} /> : t("chat.forward.pick", { count: String(FORWARD_MAX_TARGETS) })}
        </p>
        {/* There, empty, from the start: its text appearing at the limit is read once, and the rows that wait name it. */}
        <p id={`${id}-limit`} className="m-0 break-words" aria-live="polite" data-testid="forward-limit">
          {full ? t("chat.forward.limit", { count: String(FORWARD_MAX_TARGETS) }) : ""}
        </p>
      </div>
      <button type="button" data-testid="forward-cancel" onClick={onClose} disabled={busy}
        className="min-h-10 rounded-lg px-3 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent cursor-pointer">{t("common.cancel")}</button>
      {/* Not disabled while it runs: a focused button that turns disabled drops the focus to the page, and a refusal
          left Enter doing nothing. A press then is ignored by `send`. */}
      <button type="button" data-testid="forward-send" onClick={() => void send()} disabled={!chosen.length}
        aria-disabled={busy || undefined} aria-busy={busy || undefined}
        className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50 aria-disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent cursor-pointer disabled:cursor-default aria-disabled:cursor-default">
        {t("chat.forward.send")}
      </button>
    </div>
    {/* The guard's title is a string: each name isolated there by FSI…PDI. */}
    {secret && <SecretGuardDialog finding={secret} recipient={namesTitle(chosen.map(c => c.name), t)} onCancel={() => setSecret(null)} onConfirm={() => { setSecret(null); void send(true); }} />}
  </dialog>, document.body);
}

/** Names a line shows in full; more than this shows the first ones and how many more. */
const NAMES_IN_FULL = 3;

/** A list of names as a title: each isolated by FSI…PDI, as a string cannot hold a `<bdi>`. */
const namesTitle = (names: readonly string[], t: Translate) => listText(names.map(name => `\u2068${name}\u2069`), t);

/**
 * Chats' names, each in its own direction as in the rows: in one Arabic string "Ana!" read "!Ana" and the names ran in
 * English order. Listed the way the app's language lists them ("Ana وBo", "Ana、Bo"), not with an English comma.
 * `more`: said last, in the app's language, outside any name's isolation.
 */
function Names({ names, more }: { names: readonly string[]; more?: string }) {
  const { t } = useI18n();
  let item = 0;
  return listParts(more === undefined ? names : [...names, more], t).map((part, i) =>
    !part.item ? <Fragment key={i}>{part.text}</Fragment> : item++ < names.length ? <bdi key={i}>{part.text}</bdi> : <Fragment key={i}>{part.text}</Fragment>);
}

/**
 * The chats a forward goes or went to, in a line too narrow for long names (204 px on a phone): up to three in full;
 * more than that shows the first two and how many more ("Ana, Bo, 3 more"), and a screen reader hears every name.
 */
export function NameList({ names }: { names: readonly string[] }) {
  const { t } = useI18n();
  if (names.length <= NAMES_IN_FULL) return <Names names={names} />;
  const shown = names.slice(0, NAMES_IN_FULL - 1);
  return <>
    <span aria-hidden="true" data-testid="names-short"><Names names={shown} more={t("chat.forward.more", { count: String(names.length - shown.length) })} /></span>
    <span className="sr-only" data-testid="names-full"><Names names={names} /></span>
  </>;
}
