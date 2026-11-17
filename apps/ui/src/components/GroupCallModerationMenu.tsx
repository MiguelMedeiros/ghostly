import { useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n, type TranslationKey } from "../contexts/I18nContext";
import type { CallModeration } from "../hooks/useCallModeration";
import { useBackCloses, useBackdropDismiss, useQuestionDialog } from "../hooks/useDismiss";
import { errorText } from "../lib/errorText";
import { fillNames } from "../lib/fillNodes";
import type { GroupCallSource } from "../lib/groupCallModeration";
import { ownDirection } from "../lib/ownDirection";
import { InfoButton } from "./layout/Section";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

const SOURCES: { src: GroupCallSource; take: TranslationKey; give: TranslationKey }[] = [
  { src: "microphone", take: "groupCallModeration.muteMic", give: "groupCallModeration.allowMic" },
  { src: "camera", take: "groupCallModeration.stopCamera", give: "groupCallModeration.allowCamera" },
  { src: "screen_share", take: "groupCallModeration.stopScreen", give: "groupCallModeration.allowScreen" },
];

/**
 * The ⋮ on another member's tile, for the group's admin: take a source away or give it back, remove them from the call,
 * or from the group. Both removes are asked first. `host`: the call's window, which a screen reader reads alone.
 */
export function TileModerationMenu({ identity, name, moderation, host }: { identity: string; name: string; moderation: CallModeration; host: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<"call" | "group" | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const label = t("groupCallModeration.menu", { name });
  const muted = moderation.state.muted[identity] ?? [];
  const pick = (run: () => void) => () => { setOpen(false); run(); };
  const removeFromGroup = async () => {
    try {
      await engine.call("removeGroupMember", { groupId: moderation.moderator.groupId, key: identity });
    } catch (cause) {
      moderation.say(errorText(cause, t));
    }
  };
  return (
    <div ref={anchor} className="absolute top-1.5 end-1.5 z-10">
      <button type="button" onClick={() => setOpen(!open)} data-testid="group-call-moderate" aria-label={label} title={label} aria-expanded={open} aria-haspopup="true"
        className="grid h-8 w-8 max-md:h-[44px] max-md:w-[44px] cursor-pointer place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} testId="group-call-moderate-menu" label={label} portal focusFirst host={host.current}>
        {SOURCES.map(({ src, take, give }) => {
          const taken = muted.includes(src);
          return (
            <MenuItem key={src} testId={`group-call-${taken ? "allow" : "mute"}-${src}`} onClick={pick(() => void moderation.act(taken ? "allow" : "mute", identity, [src]))}>
              {t(taken ? give : take)}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <MenuItem testId="group-call-remove-from-call" danger onClick={pick(() => setAsking("call"))}>{t("groupCallModeration.removeFromCall")}</MenuItem>
        {moderation.moderator.inGroup(identity) && (
          <MenuItem testId="group-call-remove-from-group" danger onClick={pick(() => setAsking("group"))}>{t("groupCallModeration.removeFromGroup")}</MenuItem>
        )}
      </Menu>
      {asking && (
        <ConfirmRemove name={name} from={asking} returnFocus={host} onClose={() => setAsking(null)}
          onConfirm={() => { const from = asking; setAsking(null); void (from === "call" ? moderation.act("remove", identity) : removeFromGroup()); }} />
      )}
    </div>
  );
}

/**
 * "Remove Ana from the call?" or "from the group?", with an ⓘ on what it does to the call's key: a call-only remove
 * keeps it, so they still hold the current one; a group remove gives the group a new one.
 */
function ConfirmRemove({ name, from, returnFocus, onClose, onConfirm }: { name: string; from: "call" | "group"; returnFocus: RefObject<HTMLElement | null>; onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const [info, setInfo] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useBackCloses(onClose);
  useQuestionDialog(dialog, cancel, returnFocus);
  const keys = from === "call"
    ? { title: "groupCallModeration.removeFromCallTitle", body: "groupCallModeration.removeFromCallBody", info: "groupCallModeration.removeFromCallInfo", confirm: "groupCallModeration.removeFromCall" } as const
    : { title: "groupCallModeration.removeFromGroupTitle", body: "groupCallModeration.removeFromGroupBody", info: "groupCallModeration.removeFromGroupInfo", confirm: "groupCallModeration.remove" } as const;
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid={`group-call-remove-${from}-dialog`} className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="break-words text-base font-semibold">{fillNames(t(keys.title), { name })}</h2>
    <div className="mt-2 flex items-start gap-1.5">
      <p id={`${id}-body`} className="m-0 min-w-0 flex-1 text-sm text-text-muted">{t(keys.body)}</p>
      <InfoButton open={info} onToggle={() => setInfo(!info)} controls={`${id}-info`} testId={`group-call-remove-${from}-info`} className="mt-0.5" />
    </div>
    {info && <p id={`${id}-info`} data-testid={`group-call-remove-${from}-info-text`} className="mt-2 border-s-2 border-border ps-2 text-xs text-text-secondary">{t(keys.info)}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid={`group-call-remove-${from}-confirm`}
        className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger-ink hover:bg-danger/25 forced-colors:border forced-colors:border-[color:ButtonText] focus-visible:ring-2 focus-visible:ring-danger">{t(keys.confirm)}</button>
    </div>
  </dialog>, document.body);
}

/**
 * Who the admin removed from the call, out of it and so without a tile: each with Let back in, which lifts the ban
 * (they join again themselves). Beside the call's name, only while someone is removed.
 */
export function RemovedFromCall({ moderation, nameOf, host }: { moderation: CallModeration; nameOf: (identity: string) => string; host: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const banned = moderation.state.banned;
  if (!banned.length) return null;
  const label = t("groupCallModeration.removed", { count: banned.length });
  return (
    <div ref={anchor} className="relative shrink-0">
      <button type="button" onClick={() => setOpen(!open)} data-testid="group-call-removed" aria-expanded={open} aria-haspopup="true"
        className="min-h-8 max-md:min-h-11 cursor-pointer rounded-full px-2 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {label}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} testId="group-call-removed-menu" label={label} portal focusFirst align="start" host={host.current}>
        {banned.map((key) => (
          <MenuItem key={key} testId="group-call-unban" data={{ "data-identity": key }} onClick={() => { setOpen(false); void moderation.act("unban", key); }}>
            {fillNames(t("groupCallModeration.letBackIn"), { name: nameOf(key) })}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

/** The line said when an act did nothing, a few seconds. */
export function ModerationProblem({ moderation }: { moderation: CallModeration | null }) {
  const problem = moderation?.problem;
  if (!problem) return null;
  return (
    <p key={problem.id} role="alert" dir={ownDirection(problem.line)} data-testid="group-call-moderation-error"
      className="absolute top-16 left-1/2 -translate-x-1/2 z-20 w-max max-w-[calc(100%-2rem)] rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">
      {problem.line}
    </p>
  );
}
