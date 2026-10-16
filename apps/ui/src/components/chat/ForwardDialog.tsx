import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { FORWARD_MAX_TARGETS, forwardMessages, forwardSecret, type ForwardOutcome } from "../../lib/forward";
import type { SecretFinding } from "../../lib/parse/secrets";
import type { ChatMessage } from "../../lib/types";
import { SecretGuardDialog } from "../SecretGuardDialog";
import { ChatTargetRow } from "./ChatTargets";
import { useChatTargets, type ChatTarget } from "../../hooks/useChatTargets";
import { rawError } from "../../lib/errorText";
import { problemLine } from "../../lib/problemText";

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
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null);
  const targets = useChatTargets().filter(target => !!target.target);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ChatTarget[]>([]);
  const [secret, setSecret] = useState<SecretFinding | null>(null);
  const [busy, setBusy] = useState(false);
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

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    return words ? targets.filter(target => target.name.toLocaleLowerCase().includes(words)) : targets;
  }, [targets, query]);
  const isChosen = (target: ChatTarget) => chosen.some(c => c.target === target.target);
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
    onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[min(640px,calc(100dvh_-_2rem))] flex-col rounded-2xl border border-border bg-sidebar-bg p-0 text-text-primary shadow-2xl backdrop:bg-black/60 open:flex">
    <div className="px-4 pt-4 pb-2 space-y-2">
      <h2 id={`${id}-title`} className="text-base font-semibold">{t("chat.forward.title")}</h2>
      {messages.length > 1 && <p className="m-0 text-xs text-text-muted" data-testid="forward-count">{t("chat.forward.messages", { count: String(messages.length) })}</p>}
      <input ref={search} type="search" data-testid="forward-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t("chat.forward.search")} aria-label={t("chat.forward.search")}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" />
    </div>
    {/* As tall as its rows, shrinking and scrolling within the dialog's max height: `flex-1` (a basis of 0) in a
        dialog as tall as its content leaves WebKit a list of no height at all, with no chat to pick. */}
    <div className="min-h-0 flex-auto overflow-y-auto px-2">
      {shown.length === 0 ? (
        <p className="px-2 py-3 text-sm text-text-muted" data-testid="forward-none">{t(targets.length ? "chat.forward.noMatch" : "chat.forward.noChats")}</p>
      ) : (
        <ul className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-label={t("chat.forward.title")}>
          {shown.map(target => (
            <li key={target.chat}>
              <ChatTargetRow target={target} testId="forward-target" checked={isChosen(target)} onClick={() => toggle(target)}
                disabled={busy || (!isChosen(target) && chosen.length >= FORWARD_MAX_TARGETS)} />
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
    {sentTo.length > 0 && <p className="m-0 mx-4 mt-1 text-xs text-text-muted" data-testid="forward-sent">{sentBefore}<Names names={sentTo} />{sentAfter}</p>}
    <div className="flex items-center gap-2 px-4 py-3">
      <p className="m-0 min-w-0 flex-1 truncate text-xs text-text-muted" data-testid="forward-chosen">
        {chosen.length ? <Names names={chosen.map(c => c.name)} /> : t("chat.forward.pick", { count: String(FORWARD_MAX_TARGETS) })}
      </p>
      <button type="button" data-testid="forward-cancel" onClick={onClose} disabled={busy}
        className="min-h-10 rounded-lg px-3 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent cursor-pointer">{t("common.cancel")}</button>
      <button type="button" data-testid="forward-send" onClick={() => void send()} disabled={!chosen.length || busy}
        className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent cursor-pointer disabled:cursor-default">
        {t("chat.forward.send")}
      </button>
    </div>
    {/* The guard's title is a string: each name isolated there by FSI…PDI. */}
    {secret && <SecretGuardDialog finding={secret} recipient={chosen.map(c => `⁨${c.name}⁩`).join(", ")} onCancel={() => setSecret(null)} onConfirm={() => { setSecret(null); void send(true); }} />}
  </dialog>, document.body);
}

/**
 * Chats' names, each in its own direction as in the rows: in one Arabic string "Ana!" read "!Ana" and the names ran in
 * English order.
 */
function Names({ names }: { names: readonly string[] }) {
  return names.map((name, i) => <Fragment key={i}>{i > 0 && ", "}<bdi>{name}</bdi></Fragment>);
}
