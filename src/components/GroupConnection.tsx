import { useId, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { edgeDot, edgeLabel, groupTransports, memberName } from "../lib/groups";
import { dots, focus, type ConnectionKind } from "../lib/connection";
import { ConnectionIcon } from "./ConnectionIcon";
import { useI18n } from "../contexts/I18nContext";
import { agoIn } from "../lib/relativeTime";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** Some members reachable, not all: the connected icon with a warning dot. */
type GroupKind = ConnectionKind | "partial";

/**
 * The group's connection, as a 1:1 chat shows its own: an icon in the header whose tooltip sums it up
 * ("2 of 3 reachable"), and a popover with each member's edge — reachable or not, over what, last seen.
 */
export function GroupConnection({ group }: { group: GroupView }) {
  const { t, language } = useI18n();
  const state = useSyncExternalStore(subscribe, snapshot);
  const online = state?.settings.online ?? true;
  const [menuOpen, setMenuOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const others = group.members.filter(m => !m.me);
  const reachable = others.filter(m => m.edge?.state === "open").length;
  const failing = others.some(m => m.edge?.state === "error");
  const connecting = others.some(m => m.edge?.state === "connecting");
  // Group links are WebRTC only: an app with none (Ghostly Desktop on Linux) reaches no member, however long it tries.
  const noLinks = state?.transport.webrtc === false && others.length > 0;
  const kind: GroupKind = !online ? "offline" : others.length === 0 ? "waiting" : noLinks ? "failure" : reachable === others.length ? "connected"
    : reachable > 0 ? "partial" : failing ? "failure" : "waiting";
  const label = !online ? t("group.connection.offline") : others.length === 0 ? t("group.connection.onlyYou")
    : noLinks ? t("group.connection.noWebrtc")
    : reachable === 0 ? (connecting ? t("group.connection.connecting") : t("group.connection.nobody")) : t("group.connection.reachable", { reachable, total: others.length });
  const dot = kind === "partial" ? "bg-amber-500" : dots[kind];
  // Over what the reachable members are live: the icon takes the mark of the transport they share.
  const carried = online ? groupTransports(group.members, t) : undefined;
  const iconKind: ConnectionKind = kind === "partial" ? "connected" : kind;
  const close = () => { setMenuOpen(false); trigger.current?.focus(); };
  useOutsideDismiss(root, menuOpen, () => setMenuOpen(false));
  const reconnect = async (linkId: string) => {
    setBusy(linkId); setError("");
    try { await engine.call("connect", { linkId }); } catch (e) { setError(e instanceof Error ? e.message : t("group.connection.reconnectFailed")); } finally { setBusy(""); }
  };
  const now = Date.now();
  return <div ref={root} className="relative shrink-0" data-testid="group-connection" data-open={menuOpen || undefined} onKeyDown={e => {
    if (e.key !== "Escape") return;
    if (menuOpen) { e.stopPropagation(); close(); } else if (tip) { e.stopPropagation(); setTip(false); }
  }}>
      <button ref={trigger} type="button" onClick={() => { setTip(false); setMenuOpen(open => !open); }} data-testid="group-connection-options" data-state={kind} data-transport={carried?.transport}
        aria-label={t("group.connection.labelWith", { state: label })} aria-describedby={`${id}-tip`} aria-expanded={menuOpen} aria-controls={`${id}-popover`}
        onPointerEnter={e => { if (e.pointerType !== "touch") setTip(true); }} onPointerLeave={() => setTip(false)}
        onFocus={e => { if (e.currentTarget.matches(":focus-visible")) setTip(true); }} onBlur={() => setTip(false)}
        className={`relative flex cursor-pointer items-center justify-center rounded-full p-2 transition-colors max-md:p-2.5 hover:bg-surface-hover ${focus} ${kind === "failure" ? "text-danger" : kind === "offline" ? "text-text-muted hover:text-accent" : "text-text-secondary hover:text-accent"}`}>
        <ConnectionIcon kind={iconKind} transport={carried?.transport} size={18} weight={2} />
        {dot && <span aria-hidden="true" data-testid="group-connection-dot" className={`pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-panel-header max-md:right-1.5 max-md:top-1.5 ${dot} ${kind === "waiting" && connecting ? "motion-safe:animate-pulse" : ""}`} />}
      </button>
      {menuOpen && <div role="dialog" id={`${id}-popover`} aria-label={t("group.connection.label")} className="absolute right-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(21rem,calc(100vw-1rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-panel-header p-4 text-xs leading-5 text-text-muted shadow-xl">
        <div className="flex items-center gap-2 font-medium text-text-primary" data-testid="group-connection-state">
          <ConnectionIcon kind={iconKind} transport={carried?.transport} size={16} weight={1.7} />
          <span>{label}</span>
        </div>
        {carried && <p className="mt-0.5 text-[11px]" data-testid="group-connection-transports">{carried.line}</p>}
        {!online && <p className="mt-1 text-[11px]">{t("group.connection.offlineHint")}</p>}
        {online && noLinks && <p className="mt-1 text-[11px]" data-testid="group-connection-no-webrtc">{t("group.connection.noWebrtcHint")}</p>}
        <ul className="mt-3 space-y-1" data-testid="group-connection-members">
          {others.map(m => {
            const down = m.edge && m.edge.state !== "open";
            return <li key={m.key} data-testid="group-connection-member" data-key={m.key} data-state={m.edge?.state ?? "none"} className="rounded-lg bg-surface-hover px-2.5 py-1.5">
              <div className="flex min-h-8 items-center gap-2">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${edgeDot(m)}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-text-primary">{memberName(m, t)}</span>
                  <span className="block truncate text-[11px]" data-testid="group-connection-member-status">{edgeLabel(m, now, t, agoIn(language))}</span>
                </span>
                {down && online && !noLinks && <button disabled={busy !== ""} onClick={() => void reconnect(m.edge!.linkId)} data-testid="group-connection-reconnect"
                  className={`min-h-8 shrink-0 rounded-md px-2 text-accent hover:bg-surface-alt disabled:opacity-40 ${focus}`}>{busy === m.edge!.linkId ? t("group.connection.trying") : t("group.connection.reconnect")}</button>}
              </div>
              {m.edge?.state === "error" && m.edge.error && <p className="mt-0.5 break-words text-[11px] text-danger">{m.edge.error}</p>}
            </li>;
          })}
          {others.length === 0 && <li className="text-[11px]">{t("group.connection.nobodyElse")}</li>}
        </ul>
        {error && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
        <p className="mt-3 border-t border-border pt-2 text-[11px]" data-testid="group-connection-note">
          {t("group.connection.note")}
        </p>
      </div>}
    <span role="tooltip" id={`${id}-tip`} data-testid="group-connection-tooltip" className={`pointer-events-none absolute right-0 top-full z-50 mt-1.5 w-max max-w-[min(16rem,55vw)] rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] leading-4 text-text-primary shadow-lg motion-safe:transition-opacity ${tip && !menuOpen ? "opacity-100" : "invisible opacity-0"}`}>
      {label}{carried && <span data-testid="group-connection-tooltip-detail" className="mt-0.5 block text-text-secondary">{carried.line}</span>}
    </span>
    <span className="sr-only" aria-live="polite">{label}</span>
  </div>;
}
