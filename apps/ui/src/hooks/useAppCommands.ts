import { useEffect, useRef } from "react";
import { useLockScreen } from "../contexts/LockScreenContext";
import { APP_COMMAND_EVENT, isAppCommand } from "../lib/appCommands";
import { createPairedChat } from "../lib/pairedChat";
import { chatPath } from "../lib/url";
import { useAppNavigation } from "./useAppNavigation";

/** Whether a modal dialog is open: a panel that says so (`aria-modal`), or a `<dialog>`, which the app only shows as one. */
function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"], dialog[open]');
}

/**
 * Runs the app's commands from Desktop's menu and shortcuts: New starts a chat as the chat list's New button does,
 * Settings opens Settings. Nothing while the app is locked or a modal dialog is open: the page behind a dialog cannot
 * be used, and changing it would drop the dialog's work. Mounted once, in the app's layout.
 */
export function useAppCommands(): void {
  const nav = useAppNavigation();
  const { isLocked } = useLockScreen();
  // Read by the listener, which stays for the app's life: the navigation changes with every location.
  const latest = useRef({ nav, isLocked });
  latest.current = { nav, isLocked };

  useEffect(() => {
    const run = (event: Event) => {
      const command = (event as CustomEvent<unknown>).detail;
      const { nav, isLocked } = latest.current;
      if (isLocked || modalOpen() || !isAppCommand(command)) return;
      if (command === "new") void createPairedChat().then((id) => latest.current.nav.conversation(chatPath(id)), () => {});
      else nav.place("/settings");
    };
    window.addEventListener(APP_COMMAND_EVENT, run);
    return () => window.removeEventListener(APP_COMMAND_EVENT, run);
  }, []);
}
