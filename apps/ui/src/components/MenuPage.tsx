import { lazy, Suspense, useState, useSyncExternalStore, type ComponentType } from "react";
import { useT } from "../contexts/I18nContext";

/**
 * A page of the menu, loaded the first time it is opened: the first screen (the chat list) does not wait for them.
 * Nothing is drawn in its place for the moment it takes.
 *
 * In the web app the page is a file of its own, and that request can fail: the network dropped, or a deploy replaced
 * the file. The page then says so in its own place, with "Try again", and the rest of the app (the chat list, the tab
 * bar, a call) stays as it is. Left to throw, the failure took the whole app down to the last error screen, whose only
 * way out is a reload.
 */
export function menuPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  // Asked again by hand: `lazy` keeps a failure for good. The page that came takes the notice's place, on every screen showing it.
  const again = async () => {
    Page = await load();
    for (const listener of listeners) listener();
  };
  const NotLoaded = () => <PageNotLoaded again={again} />;
  let Page: ComponentType<P> = lazy(async () => {
    try {
      return { default: await load() };
    } catch (error) {
      console.warn("A page of the menu did not load:", error);
      return { default: NotLoaded as ComponentType<P> };
    }
  });
  return function MenuPage(props: P) {
    const Shown = useSyncExternalStore(subscribe, () => Page);
    return <Suspense fallback={null}><Shown {...props} /></Suspense>;
  };
}

/** "This page did not load", where the page would be. `again` settles once the page is there, and rejects while it is not. */
function PageNotLoaded({ again }: { again: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const retry = async (button: HTMLButtonElement) => {
    if (busy) return;
    setBusy(true);
    // The page takes this notice's place, button and all: the keyboard focus goes to the page's region, not to the body.
    const region = button.closest<HTMLElement>("main");
    try {
      await again();
      if (document.activeElement === button || document.activeElement === document.body) region?.focus();
    } catch (error) {
      console.warn("A page of the menu did not load:", error);
      setBusy(false);
    }
  };
  return (
    <div role="alert" data-testid="page-not-loaded" className="flex-1 min-h-0 overflow-y-auto grid place-items-center bg-chat-bg p-6 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-5xl" aria-hidden="true">👻</div>
        <p className="text-text-primary font-semibold break-words">{t("app.pageNotLoaded.title")}</p>
        <p className="text-text-secondary text-sm break-words">{t("app.pageNotLoaded.hint")}</p>
        {/* `aria-disabled`, not `disabled`: a disabled button gives up the keyboard focus while the file is asked for. */}
        <button type="button" data-testid="page-not-loaded-retry" aria-disabled={busy || undefined} aria-busy={busy || undefined}
          onClick={(event) => void retry(event.currentTarget)}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer aria-disabled:opacity-60 aria-disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-chat-bg">
          {t("app.pageNotLoaded.tryAgain")}
        </button>
      </div>
    </div>
  );
}
