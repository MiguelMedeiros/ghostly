import { useEffect, useState, type ReactNode } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AttentionFeedback } from "./components/AttentionFeedback";
import { App } from "./App";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Services } from "./pages/Services";
import { Profile } from "./pages/Profile";
import { Identities } from "./pages/Identities";
import { Wallet } from "./pages/Wallet";
import { GroupChat } from "./pages/GroupChat";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./contexts/I18nContext";
import { LockScreenProvider, useLockScreen } from "./contexts/LockScreenContext";
import { UpdateProvider } from "./contexts/UpdateContext";
import { LockScreen } from "./components/LockScreen";
import { ensureSession, loadSession } from "./lib/storage";
import { useI18n } from "./contexts/I18nContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { chatPath, parseChatRoute } from "./lib/url";
import { groupPath } from "./lib/groups";
import { engine } from "@ghostly/browser/platform/engine";
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
  const { t } = useI18n();
  const [invalid, setInvalid] = useState(false);

  // An effect, not a layout effect: the router starts listening in its own layout effect, after this
  // one's, and would miss a navigation made before it (an invite link opened in a new tab).
  useEffect(() => {
    const rest = pathname.match(/^\/chat\/(.+)$/)?.[1];
    if (!rest) return;
    const keys = parseChatRoute(pathname);
    let sessionId: string | null = null;
    if (keys) {
      try { sessionId = ensureSession(keys); } catch { sessionId = null; }
    } else if (!rest.includes("/") && loadSession(decodeURIComponent(rest))) return; // an ordinary chat address
    if (!sessionId) {
      // Whatever it was, it leaves the address bar and the history: it may hold a key.
      setInvalid(true);
      navigate("/", { replace: true });
      return;
    }
    window.dispatchEvent(new Event("session-updated"));
    navigate(chatPath(sessionId), { replace: true });
  }, [pathname, navigate]);

  useEffect(() => {
    if (!invalid) return;
    const timer = setTimeout(() => setInvalid(false), 6000);
    return () => clearTimeout(timer);
  }, [invalid]);

  return invalid ? (
    <div role="alert" data-testid="invite-link-invalid" onClick={() => setInvalid(false)}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-danger shadow-xl cursor-pointer">
      {t("join.invalid")}
    </div>
  ) : null;
}

/**
 * A group's link opened in the app (`#/join/group1/…`): it leaves the address at once, like an
 * invite; once the app is unlocked the engine joins and the group opens, saying it waits for the admin's app.
 */
function GroupLinkIntake() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { hasUnlocked } = useLockScreen();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  useEffect(() => {
    const found = pathname.match(/^\/join\/(.+)$/)?.[1];
    if (!found) return;
    setCode(decodeURIComponent(found));
    navigate("/", { replace: true });
  }, [pathname, navigate]);
  useEffect(() => {
    if (!code || !hasUnlocked) return;
    setCode("");
    engine.call("joinGroupByLink", { link: code })
      .then(({ groupId }) => navigate(groupPath(groupId)))
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : "This link to a group does not work"));
  }, [code, hasUnlocked, navigate]);
  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setProblem(""), 6000);
    return () => clearTimeout(timer);
  }, [problem]);
  return problem ? (
    <div role="alert" data-testid="group-link-invalid" onClick={() => setProblem("")}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-danger shadow-xl cursor-pointer">
      {problem}
    </div>
  ) : null;
}

/**
 * A chat has no route element of its own: `App` keeps it loaded across a trip
 * to Settings, so a call it holds is not hung up on the way.
 */
const ChatRoute = () => null;

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
            <HashRouter>
              <ErrorBoundary>
              <ChatLinkIntake />
              <GroupLinkIntake />
              <LockGate>
                {/* Asking for updates says this device runs Ghostly: not before the password. */}
                <UpdateProvider>
                  <AttentionFeedback />
                  <Routes>
                    <Route element={<App />}>
                      <Route path="/" element={<Home />} />
                      <Route path="/chat/*" element={<ChatRoute />} />
                      <Route path="/group/:groupId" element={<GroupChat />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/wallet" element={<Wallet />} />
                      <Route path="/services" element={<Services />} />
                      <Route path="/profile" element={<Profile />} />
                      <Route path="/identities" element={<Identities />} />
                      <Route path="/share" element={<Navigate to="/services" replace />} />
                    </Route>
                  </Routes>
                </UpdateProvider>
              </LockGate>
              </ErrorBoundary>
            </HashRouter>
          </LockScreenProvider>
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}
