import { useContext, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePhoneHeader } from "../../hooks/usePhoneHeader";
import { useBackCloses, useTabTrap } from "../../hooks/useDismiss";
import { takedownText, useAppOpener } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";
import { ChatOnScreen } from "../../lib/chatOnScreen";
import { chatApp, registerAppSlot, setChatApp, setChatAppNarrow, updateChatApp, useChatApp, useChatAppNarrow, type AppContact } from "../../lib/apps/running";
import { PeerAvatar } from "../Avatar";
import { ChatConnection } from "../ChatConnection";
import { AppGlyph } from "./AppIcon";
import { NAME, aroundName } from "./aroundName";
import "./chat-app-panel.css";

/**
 * The chat's page narrower than this has no room for the app beside a chat that still works: the panel's least width
 * (360 px, chat-app-panel.css) and a phone's width for the chat (320 px, as the chat list leaves the page).
 */
const BESIDE_MIN = 680;

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * A mini-app in a 1:1 chat (WISP 1200 § Per client, web): beside the chat on a wide screen, over it on a phone, with
 * the chat's own look in its header: the app's name, "with" the contact and their picture, and the chat's connection
 * control. Wide: Close, and the whole chat's width or back beside it. Phone: Back to the chat (the app keeps running;
 * `ChatAppResume` or opening it again brings it back) and Close. A full-screen app (its manifest's `view` is `full`)
 * never sits beside the chat: it covers the whole chat at every width, with Back to it and Close. So does any app where
 * the chat's page has no room for both (`BESIDE_MIN`: a tablet held upright, a narrow window).
 *
 * The frame box is always here while the chat is, hidden when no app shows: a frame that moved would reload. The
 * header is drawn only while the app shows.
 *
 * Keys: opening moves the focus in (Back on a phone, the panel itself beside the chat), and closing or going Back
 * gives it back (to what opened it, "Back to Chess" after Back, else the message field). On a phone the panel is
 * modal: Tab stays in it and the chat under it is inert. Escape, with the focus in the panel, goes Back on a phone and
 * for a full-screen app, back beside the chat from full width, and closes it beside the chat.
 *
 * The browser's Back (Android's back gesture) with Back here on screen does what Back does: the app hides and the
 * person stays in the chat, as with a dialog or a sheet (lib/layerHistory.ts). Beside the chat it is part of the page,
 * and Back leaves the chat as usual.
 */
export function ChatAppPanel({ linkId, sessionId, contact, peerKey, photo, myKey, status, callOn }: {
  linkId: string;
  sessionId: string;
  contact: AppContact;
  peerKey: string;
  /** The picture of the identity the contact is shown as, when one was chosen. */
  photo?: string;
  myKey?: string;
  status?: string;
  /** A call is on in the chat: its connection control offers no DHT only meanwhile. */
  callOn?: boolean;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  // A phone held upright: the header's buttons are the chat header's size there (Chat.tsx).
  const phoneHeader = usePhoneHeader();
  const app = useChatApp(linkId);
  const appOpener = useAppOpener();
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { name, named } = contact;
  // Open again under a stopped app: busy while it opens, and why it failed, for that stopped app only.
  const [again, setAgain] = useState<{ of: unknown; busy?: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (box.current) registerAppSlot(linkId, { box: box.current, sessionId, contact: { name, named } });
  }, [linkId, sessionId, name, named]);
  // The chat closed: the app in it stops.
  useEffect(() => () => registerAppSlot(linkId, null), [linkId]);

  // No room beside the chat (a tablet held upright, a narrow window): the app covers it, as a full-screen app does.
  const narrow = useChatAppNarrow(linkId);
  useEffect(() => {
    const pane = root.current?.parentElement;
    if (phone || !pane) { setChatAppNarrow(linkId, false); return; }
    // 0: not laid out (a chat kept loaded off screen); measured again as it shows. The contact's identities take none of
    // this page from an app beside the chat: they lie over the chat while one is there, wherever its 360 px would leave
    // the chat less than 320 (contact-panel.css). Measured with them docked while the app was hidden, the app covered the
    // chat when they opened first, and sat beside it when it opened first (bug hunt, 2026-11-14).
    const measure = () => setChatAppNarrow(linkId, pane.clientWidth > 0 && pane.clientWidth < BESIDE_MIN);
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    measure();
    return () => { observer.disconnect(); setChatAppNarrow(linkId, false); };
  }, [linkId, phone]);

  const shown = !!app?.shown;
  const full = app?.view === "full";
  // Back to the chat: on a phone, and for a full-screen app or one with no room beside the chat at every width.
  const withBack = phone || full || narrow;
  const wide = !phone && (full || narrow || !!app?.wide);
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
  const backNow = useRef(withBack); backNow.current = withBack;
  useEffect(() => {
    if (!shown) return;
    const panel = root.current;
    const was = document.activeElement as HTMLElement | null;
    // Back in from "Back to Chess" (gone by now, the focus with it): what opened it first is still the way back.
    if (was && was !== document.body && !panel?.contains(was) && was.dataset.testid !== "mini-app-resume") opener.current = was;
    (backNow.current ? back.current : panel)?.focus({ preventScroll: true });
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

  // Stopped while shown (the watchdog, a takedown, its frame navigated): the focus was in its frame, gone with it, so it
  // goes to Open again when offered, else in the panel as on open, and Escape still closes; never pulled from where the
  // person went meanwhile.
  const stopped = shown ? app?.stopped : undefined;
  useEffect(() => {
    if (!stopped) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const panel = root.current;
    (panel?.querySelector<HTMLElement>("[data-testid=mini-app-open-again]") ?? (backNow.current ? back.current : panel))?.focus({ preventScroll: true });
  }, [stopped]);

  // A stopped app (a takedown) has nothing left to stop: Close takes its message away.
  const close = () => { if (app?.stopped) setChatApp(linkId, null); else app?.running.stop(); };
  const openAgain = () => {
    if (!app || !appOpener || (again?.of === app.running && again.busy)) return;
    const of = app.running;
    setAgain({ of, busy: true });
    // Opened with Run anyway (a version a store removed): again the same way, as the person chose.
    appOpener(app.ref, linkId, { runAnyway: app.runAnyway === true, again: of }).then(() => {
      setAgain(null);
      // Its button went with the stopped message: the focus goes back into the panel, as on first open, unless the
      // person went elsewhere meanwhile.
      const panel = root.current;
      const active = document.activeElement;
      if (active && active !== document.body && !panel?.contains(active)) return;
      (withBack ? back.current : panel)?.focus({ preventScroll: true });
    }, (error: unknown) => {
      console.warn(`[apps] ${title} did not open again`, error);
      setAgain({ of, error: appErrorText(error, t) });
    });
  };
  const againHere = again && again.of === app?.running ? again : null;
  // Back to the chat: the app keeps running, "Back to Chess" brings it back; a stopped one has nothing to come back to.
  const goBack = () => (app?.stopped ? setChatApp(linkId, null) : updateChatApp(linkId, { shown: false }));
  // Only while its chat is the one on screen: a chat kept loaded off screen (App's `loaded`) leaves Back to the page.
  const onScreen = useContext(ChatOnScreen);
  useBackCloses(goBack, shown && withBack && onScreen);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !app) return;
    e.preventDefault();
    if (withBack && !app.stopped) updateChatApp(linkId, { shown: false });
    // Back beside the chat only where it can be: a full-screen app, or one with no room beside it, closes.
    else if (wide && !withBack) updateChatApp(linkId, { wide: false });
    else close();
  };
  return (
    <section ref={root} tabIndex={-1} onKeyDown={onKeyDown} data-testid="mini-app" data-place={phone ? "phone" : full ? "full" : wide ? "wide" : "beside"} data-view={app?.view} hidden={!shown}
      role={modal ? "dialog" : undefined} aria-modal={modal || undefined}
      aria-label={app ? t("apps.view.with", { title, name }) : undefined} className="chat-app-panel outline-none" data-wide={wide || undefined}>
      {modal && <TabTrap root={root} />}
      {/* The header only while the app shows: the chat's own header is the only one otherwise. */}
      {shown && <div className="chat-app-head h-14 header-safe flex items-center gap-2 max-md:gap-1 px-3 max-md:ps-1 max-md:pe-1 bg-panel-header border-b border-border shrink-0">
        {withBack && (
          <button ref={back} type="button" data-testid="mini-app-back" onClick={goBack}
            aria-label={t("apps.view.back")} title={t("apps.view.back")}
            className={`${phoneHeader ? "w-11 max-[340px]:w-9 tap-target" : "w-9"} h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100"><path d="M15 19l-7-7 7-7" /></svg>
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
          <h2 data-testid="mini-app-title" dir="auto" className="text-match-parent m-0 text-[15px] font-semibold leading-tight text-text-primary truncate">{title}</h2>
          {/* While the app serves a file to the contact, the line says so (WISP 1200 § A read lane to the contact). */}
          <p data-testid="mini-app-with" data-serving={app?.serving || undefined} className={`m-0 flex min-w-0 overflow-hidden text-[12px] leading-tight whitespace-nowrap ${named ? "text-text-secondary" : "text-text-muted italic"}`}>
            {aroundName(t(app?.serving ? "apps.view.sharingWith" : "apps.view.withName", { name: NAME }), name)}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* The chat's connection control, the same as in its header: on a phone held upright, 44 px to tap as there. */}
          <ChatConnection peerKey={peerKey} myKey={myKey} status={status} testIdPrefix="app-" callOn={callOn} phone={phoneHeader} />
          {/* Named for what it does next ("Full width", "Show the chat"), so it is no toggle: "Show the chat, pressed" was
              read with the chat hidden. */}
          {!withBack && (
            <button type="button" data-testid="mini-app-wide" onClick={() => updateChatApp(linkId, { wide: !wide })}
              aria-label={t(wide ? "apps.view.beside" : "apps.view.full")} title={t(wide ? "apps.view.beside" : "apps.view.full")}
              className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {wide
                ? <svg {...iconProps}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
                : <svg {...iconProps}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}
            </button>
          )}
          <button type="button" data-testid="mini-app-close" onClick={close} aria-label={t("common.close")} title={t("common.close")}
            className={`${phoneHeader ? "w-11 h-11 flex items-center justify-center" : "p-2 max-md:px-1.5 max-md:py-2.5"} text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
            <svg {...iconProps} width={phoneHeader ? 20 : 18} height={phoneHeader ? 20 : 18}><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>}
      {/* Stopped by the client (a takedown): why, in the app's place, until Close. Said politely in a line that is always
          there, as a live region must be before what it says: the focus stays in the chat beside it, or goes to a bare
          "Open again", and a line that came with its words was not read out. */}
      <div role="status">
        {shown && app?.stopped && <p data-testid="mini-app-stopped" className="m-0 p-6 text-center text-sm text-text-secondary">
          {takedownText(title, app.stopped, t)}
        </p>}
      </div>
      {/* Stopped by the watchdog: it may run fine once started again, and the person decides. */}
      {shown && app?.stopped?.why === "unresponsive" && appOpener && (
        <button type="button" data-testid="mini-app-open-again" onClick={openAgain}
          aria-busy={againHere?.busy || undefined} aria-disabled={againHere?.busy || undefined}
          className="mx-auto min-h-11 rounded border border-accent px-4 py-1 text-sm font-medium text-accent hover:bg-surface-hover cursor-pointer aria-disabled:cursor-wait aria-disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {t("apps.view.openAgain")}
        </button>
      )}
      {shown && app?.stopped && againHere?.error && <p role="alert" data-testid="mini-app-open-again-error" className="m-0 px-6 py-2 text-center text-sm text-danger-ink">
        {againHere.error}
      </p>}
      <div ref={box} data-testid="mini-app-frame" className="chat-app-frame" />
    </section>
  );
}

/** Tab stays in the panel while it covers the chat. */
function TabTrap({ root }: { root: RefObject<HTMLElement | null> }) {
  useTabTrap(root);
  return null;
}

/**
 * On a phone, an app the person went Back from: still running, one tap away, under the chat's header. While it serves
 * a file to the contact, it says so here too (WISP 1200 § A read lane to the contact): the panel's header is hidden.
 * One that stopped meanwhile (a takedown, the watchdog) says "Stopped" here, and why once it is shown.
 */
export function ChatAppResume({ linkId }: { linkId: string }) {
  const { t } = useI18n();
  const app = useChatApp(linkId);
  if (!app || app.shown) return null;
  return (
    <button type="button" data-testid="mini-app-resume" data-serving={app.serving || undefined} onClick={() => updateChatApp(linkId, { shown: true })}
      className="flex w-full items-center gap-2 px-4 py-2 bg-panel-header border-b border-border text-[13px] font-medium text-accent hover:bg-surface-hover cursor-pointer shrink-0 text-start">
      <AppGlyph size={16} />
      <span className="min-w-0 flex-1">
        {/* Only the title is cut, in its own direction: a Latin title in Arabic kept its end and lost its first letters,
            and "<title> に戻る" lost the words after a long one. */}
        <span className="flex min-w-0 overflow-hidden whitespace-nowrap">{aroundName(t("apps.view.resume", { title: NAME }), app.title, "mini-app-resume-title")}</span>
        {/* A line of its own: beside the title, a narrow phone cut the app's name in some languages. */}
        {app.serving && <span data-testid="mini-app-resume-sharing" className="block truncate text-[12px] font-normal text-text-secondary">
          <span className="sr-only">, </span>{t("apps.view.resumeSharing")}
        </span>}
        {/* Stopped while the person was in the chat: the panel says why once they go back to it. */}
        {app.stopped && <span data-testid="mini-app-resume-stopped" className="block truncate text-[12px] font-normal text-danger-ink">
          <span className="sr-only">, </span>{t("apps.app.stopped")}
        </span>}
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100"><path d="m9 18 6-6-6-6" /></svg>
    </button>
  );
}
