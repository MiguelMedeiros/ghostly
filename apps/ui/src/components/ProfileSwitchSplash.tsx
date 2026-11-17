import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import { clearPendingSwitch, pendingSwitch, type PendingSwitch } from "../lib/profiles";
import { fillNames } from "../lib/fillNodes";
import { initial } from "../lib/initial";
import { isolate } from "../lib/ownStatus";

const subscribe = (listener: () => void) => engine.subscribe(listener);

/**
 * Everything on the page but `overlay` made inert (the app, and what it put on the body: a dialog, a toast), and what
 * comes on the body meanwhile too. Gives back only what it made inert: what was inert before stays so.
 */
function holdPageUnder(overlay: HTMLElement): () => void {
  const held = new Set<Element>();
  const hold = (node: Node) => {
    if (!(node instanceof Element) || node === overlay || node.hasAttribute("inert")) return;
    node.setAttribute("inert", "");
    held.add(node);
  };
  for (const node of document.body.children) hold(node);
  const added = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(hold)));
  added.observe(document.body, { childList: true });
  return () => {
    added.disconnect();
    for (const node of held) node.removeAttribute("inert");
  };
}

/** The overlay's look, on its own so the entry points can show it before the app is there. */
export function ProfileSwitchView({ pending, arrived, leaving, label, textRef }: { pending: PendingSwitch; arrived?: boolean; leaving?: boolean; label: ReactNode; textRef?: Ref<HTMLParagraphElement> }) {
  return (
    <div role="status" aria-live="polite" data-testid="profile-switch-splash" data-leaving={leaving || undefined}
      className={`${arrived && !leaving ? "" : "profile-switch-splash "}fixed inset-0 z-[70] grid place-items-center bg-app-bg`}
      style={{ background: "var(--theme-app-bg, #222e35)" }}>
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <span className="profile-switch-badge grid place-items-center rounded-full overflow-hidden" style={{ width: 76, height: 76, boxShadow: `0 0 0 3px var(--theme-app-bg, #222e35), 0 0 0 6px ${pending.color}` }}>
          {pending.avatar
            ? <img src={pending.avatar} alt="" className="w-full h-full object-cover" />
            : <span aria-hidden="true" className="grid place-items-center w-full h-full text-[32px] font-semibold text-[#111b21]" style={{ background: pending.color }}>{initial(pending.name)}</span>}
        </span>
        {/* Where the focus waits while the page under it is out of reach. */}
        <p ref={textRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none" style={{ color: "var(--theme-text-primary, #e9edef)" }}>{label}</p>
      </div>
    </div>
  );
}

/**
 * Switching profiles restarts the app on the other profile's storage (WISP 04). Instead of a blank page,
 * the profile being opened shows from the tap until its peer has started, or its lock screen is up: the
 * old page shows it until it reloads, the new one takes over from the same state and then lets go.
 */
export function ProfileSwitchSplash() {
  const { t } = useI18n();
  const { isLocked } = useLockScreen();
  const [arrived] = useState(() => !!pendingSwitch());
  const [pending, setPending] = useState<PendingSwitch | null>(() => pendingSwitch());
  const [leaving, setLeaving] = useState(false);
  // Something to see: the profile, the notice that it cannot be opened (`ProfileUnavailable`), or the standby screen.
  const ready = useSyncExternalStore(subscribe, () => !!engine.state || !!engine.startFailure || !!engine.deviceGate);

  useEffect(() => {
    const starting = (e: Event) => setPending((e as CustomEvent<PendingSwitch>).detail);
    window.addEventListener("profile-switching", starting);
    return () => window.removeEventListener("profile-switching", starting);
  }, []);
  // After the reload: gone once there is something to see (a moment, so it does not blink), or after 8 s whatever happens.
  useEffect(() => {
    if (!pending || !arrived || leaving) return;
    const timer = setTimeout(() => setLeaving(true), ready || isLocked ? 250 : 8000);
    return () => clearTimeout(timer);
  }, [pending, arrived, leaving, ready, isLocked]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => { clearPendingSwitch(); setPending(null); }, 180);
    return () => clearTimeout(timer);
  }, [leaving]);

  // While it is up (8 s at most on a page that follows another tab's switch), the page under it is out of reach: Tab
  // walked through the controls of a page nobody could see, Enter pressed them, and a screen reader read it. The focus
  // waits on its words. Not under the lock screen, a modal dialog over everything that takes the password meanwhile.
  const text = useRef<HTMLParagraphElement>(null);
  const up = !!pending && !leaving && !isLocked;
  const overlayOf = (words: HTMLElement | null) => words?.closest<HTMLElement>("[data-testid=profile-switch-splash]");
  useLayoutEffect(() => {
    const words = text.current, overlay = overlayOf(words);
    if (!up || !words || !overlay) return;
    const release = holdPageUnder(overlay);
    words.focus({ preventScroll: true });
    return release;
  }, [up]);
  // Lifted: the focus at the page's start, as a move to another page puts it (App.tsx), on the open page's `main` that
  // the skip link focuses. Where it has none (a phone), or that page is under the lock, the page itself. Once the
  // render is in: React puts back, at the end of its commit, the focus a layout effect moved during it.
  useEffect(() => {
    const words = text.current, overlay = overlayOf(words);
    if (!up || !words || !overlay) return;
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && !overlay.contains(active)) return;
      const main = document.querySelector<HTMLElement>("main[tabindex='-1']");
      if (main && !main.closest("[inert]")) main.focus({ preventScroll: true });
      else if (active instanceof HTMLElement && overlay.contains(active)) active.blur();
    };
  }, [up]);

  if (!pending) return null;
  // The profile's name isolated in a line in the page's direction: "Club!" read "!Club" in Arabic. A page that only
  // follows another tab's switch says who made it.
  const label = pending.elsewhere === true
    ? fillNames(t("profileSwitcher.switchingFromOtherTab"), { name: pending.name })
    : t("profileSwitcher.switching", { name: isolate(pending.name) });
  // On the body, beside the app rather than in it: everything else there is made inert while it is up.
  return createPortal(<ProfileSwitchView pending={pending} arrived={arrived} leaving={leaving} label={label} textRef={text} />, document.body);
}
