import { useLayoutEffect, type ReactNode } from "react";
import { HashRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { App } from "./App";
import { Home } from "./pages/Home";
import { Chat } from "./pages/Chat";
import { Settings } from "./pages/Settings";
import { ShareTab, WalletTab } from "./pages/MobileTabs";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./contexts/I18nContext";
import { LockScreenProvider, useLockScreen } from "./contexts/LockScreenContext";
import { UpdateProvider } from "./contexts/UpdateContext";
import { LockScreen } from "./components/LockScreen";
import { ensureSession } from "./lib/storage";
import { chatPath, parseChatRoute } from "./lib/url";
import "./index.css";

/**
 * An invite link, or a chat address from before chats were routed by session
 * id, carries the chat's keys. Store them and replace the address at once, so
 * the keys stay out of the history. Runs while locked too: the address must
 * not wait for the password.
 */
function ChatLinkIntake() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useLayoutEffect(() => {
    const keys = parseChatRoute(pathname);
    if (!keys) return;
    const sessionId = ensureSession(keys);
    window.dispatchEvent(new Event("session-updated"));
    navigate(chatPath(sessionId), { replace: true });
  }, [pathname, navigate]);

  return null;
}

/**
 * Nothing of the app exists until the password has been entered once. When it
 * locks again later the app stays mounted (a call keeps going) but can be
 * neither reached nor read by assistive technology under the lock screen.
 */
function LockGate({ children }: { children: ReactNode }) {
  const { isLocked, hasUnlocked } = useLockScreen();
  if (!hasUnlocked) return null;
  return (
    <div style={{ display: "contents" }} inert={isLocked} aria-hidden={isLocked || undefined}>
      {children}
    </div>
  );
}

/** The whole Ghostly UI. Desktop and Browser both render this; only the platform modules differ. */
export function Root() {
  return (
    <SettingsProvider>
      <ThemeProvider>
        <I18nProvider>
          <LockScreenProvider>
            <LockScreen />
            <UpdateProvider>
              <HashRouter>
                <ChatLinkIntake />
                <LockGate>
                  <Routes>
                    <Route element={<App />}>
                      <Route path="/" element={<Home />} />
                      <Route path="/chat/*" element={<Chat />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/wallet" element={<WalletTab />} />
                      <Route path="/share" element={<ShareTab />} />
                    </Route>
                  </Routes>
                </LockGate>
              </HashRouter>
            </UpdateProvider>
          </LockScreenProvider>
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}
