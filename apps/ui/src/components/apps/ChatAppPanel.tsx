import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useTabTrap } from "../../hooks/useDismiss";
import { chatApp, registerAppSlot, updateChatApp, useChatApp, type AppContact } from "../../lib/apps/running";
import { PeerAvatar } from "../Avatar";
import { ChatConnection } from "../ChatConnection";
import { AppGlyph } from "./AppIcon";
import "./chat-app-panel.css";

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * A mini-app in a 1:1 chat (WISP 1200 § Per client, web): beside the chat on a wide screen, over it on a phone, with
 * the chat's own look in its header: the app's name, "with" the contact and their picture, and the chat's connection
 * control. Wide: Close, and the whole chat's width or back beside it. Phone: Back to the chat (the app keeps running;
 * `ChatAppResume` or opening it again brings it back) and Close.
 *
 * The frame box is always here while the chat is, hidden when no app shows: a frame that moved would reload. The
 * header is drawn only while the app shows.
 *
 * Keys: opening moves the focus in (Back on a phone, the panel itself beside the chat), and closing or going Back
 * gives it back (to what opened it, "Back to Chess" after Back, else the message field). On a phone the panel is
 * modal: Tab stays in it and the chat under it is inert. Escape, with the focus in the panel, goes Back on a phone,
 * back beside the chat from full width, and closes it beside the chat.
 */
export function ChatAppPanel({ linkId, sessionId, contact, peerKey, photo, myKey, status }: {
  linkId: string;
  sessionId: string;
  contact: AppContact;
  peerKey: string;
  /** The picture of the identity the contact is shown as, when one was chosen. */
  photo?: string;
  myKey?: string;
  status?: string;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const app = useChatApp(linkId);
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { name, named } = contact;

  useEffect(() => {
    if (box.current) registerAppSlot(linkId, { box: box.current, sessionId, contact: { name, named } });
  }, [linkId, sessionId, name, named]);
  // The chat closed: the app in it stops.
  useEffect(() => () => registerAppSlot(linkId, null), [linkId]);

  const shown = !!app?.shown;
  const wide = !phone && !!app?.wide;
  const title = app?.title ?? "";
  const modal = shown && phone;

  // Over the chat on a phone: the chat under it is out of reach (Tab, a screen reader) until Back. Before the focus
  // effect, so the focus can go back into the chat as the panel goes.
  useEffect(() => {
    if (!modal) return;
    const column = root.current?.parentElement?.querySelector<HTMLElement>(":scope > .chat-column");
    if (!column) return;
    column.inert = true;
    return () => { column.inert = false; };
  }, [modal]);

  // Shown: the focus goes in, and comes back where it was when it goes. Read once per showing, not per resize.
  const phoneNow = useRef(phone); phoneNow.current = phone;
  useEffect(() => {
    if (!shown) return;
    const panel = root.current;
    const was = document.activeElement as HTMLElement | null;
    // Back in from "Back to Chess" (gone by now, the focus with it): what opened it first is still the way back.
    if (was && was !== document.body && !panel?.contains(was) && was.dataset.testid !== "mini-app-resume") opener.current = was;
    (phoneNow.current ? back.current : panel)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      // Never pulled from where the person went meanwhile (the chat beside it, another page).
      if (active && active !== document.body && !panel?.contains(active)) return;
      const column = panel?.parentElement?.querySelector<HTMLElement>(":scope > .chat-column");
      const running = !!chatApp(linkId);
      const target = (running ? column?.querySelector<HTMLElement>("[data-testid=mini-app-resume]") : null)
        ?? (opener.current?.isConnected ? opener.current : null)
        ?? column?.querySelector<HTMLElement>("textarea");
      target?.focus({ preventScroll: true });
    };
  }, [shown, linkId]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !app) return;
    e.preventDefault();
    if (phone) updateChatApp(linkId, { shown: false });
    else if (wide) updateChatApp(linkId, { wide: false });
    else app.running.stop();
  };
  return (
    <section ref={root} tabIndex={-1} onKeyDown={onKeyDown} data-testid="mini-app" data-place={phone ? "phone" : wide ? "wide" : "beside"} hidden={!shown}
      role={modal ? "dialog" : undefined} aria-modal={modal || undefined}
      aria-label={app ? t("apps.view.with", { title, name }) : undefined} className="chat-app-panel outline-none" data-wide={wide || undefined}>
      {modal && <TabTrap root={root} />}
      {/* The header only while the app shows: the chat's own header is the only one otherwise. */}
      {shown && <div className="chat-app-head h-14 header-safe flex items-center gap-2 max-md:gap-1 px-3 max-md:ps-1 max-md:pe-1 bg-panel-header border-b border-border shrink-0">
        {phone && (
          <button ref={back} type="button" data-testid="mini-app-back" onClick={() => updateChatApp(linkId, { shown: false })}
            aria-label={t("apps.view.back")} title={t("apps.view.back")}
            className="w-9 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        <span data-testid="mini-app-avatar" className="relative w-9 h-9 rounded-full bg-surface-hover flex items-center justify-center shrink-0 [--ring:var(--theme-panel-header)]">
          <PeerAvatar peerPubKey={peerKey} label={name} named={named} photo={photo} />
          {/* The app on the contact's corner: this is the app, with them. */}
          <span aria-hidden="true" className="absolute -bottom-1 -end-1 grid place-items-center w-[18px] h-[18px] rounded-md bg-accent text-on-accent ring-2 ring-panel-header">
            <AppGlyph size={11} />
          </span>
        </span>
        <div className="min-w-0 flex-1 ms-1">
          <h2 data-testid="mini-app-title" className="m-0 text-[15px] font-semibold leading-tight text-text-primary truncate">{title}</h2>
          <p data-testid="mini-app-with" className={`m-0 text-[12px] leading-tight truncate ${named ? "text-text-secondary" : "text-text-muted italic"}`}>
            <bdi>{t("apps.view.withName", { name })}</bdi>
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* The chat's connection control, the same as in its header. */}
          <ChatConnection peerKey={peerKey} myKey={myKey} status={status} testIdPrefix="app-" />
          {!phone && (
            <button type="button" data-testid="mini-app-wide" aria-pressed={wide} onClick={() => updateChatApp(linkId, { wide: !wide })}
              aria-label={t(wide ? "apps.view.beside" : "apps.view.full")} title={t(wide ? "apps.view.beside" : "apps.view.full")}
              className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {wide
                ? <svg {...iconProps}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
                : <svg {...iconProps}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}
            </button>
          )}
          <button type="button" data-testid="mini-app-close" onClick={() => app?.running.stop()} aria-label={t("common.close")} title={t("common.close")}
            className="p-2 max-md:px-1.5 max-md:py-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <svg {...iconProps}><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>}
      {/* What the client says about the app, outside its frame (a stop it did not ask for). */}
      {shown && app?.note && <p role="status" data-testid="mini-app-note" className="m-0 px-4 py-2 text-[13px] text-text-secondary bg-panel-header border-b border-border shrink-0">{app.note}</p>}
      <div ref={box} data-testid="mini-app-frame" className="chat-app-frame" />
    </section>
  );
}

/** Tab stays in the panel while it covers the chat. */
function TabTrap({ root }: { root: RefObject<HTMLElement | null> }) {
  useTabTrap(root);
  return null;
}

/** On a phone, an app the person went Back from: still running, one tap away, under the chat's header. */
export function ChatAppResume({ linkId }: { linkId: string }) {
  const { t } = useI18n();
  const app = useChatApp(linkId);
  if (!app || app.shown) return null;
  return (
    <button type="button" data-testid="mini-app-resume" onClick={() => updateChatApp(linkId, { shown: true })}
      className="flex w-full items-center gap-2 px-4 py-2 bg-panel-header border-b border-border text-[13px] font-medium text-accent hover:bg-surface-hover cursor-pointer shrink-0 text-start">
      <AppGlyph size={16} />
      <span className="min-w-0 flex-1 truncate">{t("apps.view.resume", { title: app.title })}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100"><path d="m9 18 6-6-6-6" /></svg>
    </button>
  );
}
