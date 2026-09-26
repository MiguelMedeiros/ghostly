import { useEffect, useState, type ReactNode } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AttentionFeedback } from "./components/AttentionFeedback";
import { App } from "./App";
import { Home } from "./pages/Home";
import { AdvancedSettings, Settings } from "./pages/Settings";
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
import { ProfileSwitchSplash } from "./components/ProfileSwitchSplash";
import { ensureSession, loadSession } from "./lib/storage";
import { useI18n } from "./contexts/I18nContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { INVITE_REFUSAL_MESSAGE, chatPath, classifyInvite, inviteRouteCode, readInvite } from "./lib/url";
import { onJoinNotice, showJoinNotice, type JoinNoticeKey } from "./lib/joinNotice";
import { groupPath } from "./lib/groups";
import { engine } from "@ghostly/browser/platform/engine";
import { useAnchorHome, useAppNavigation } from "./hooks/useAppNavigation";
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
  const [invalid, setInvalid] = useState<(typeof INVITE_REFUSAL_MESSAGE)[keyof typeof INVITE_REFUSAL_MESSAGE] | "join.invalid" | null>(null);

  // An effect, not a layout effect: the router starts listening in its own layout effect, after this
  // one's, and would miss a navigation made before it (an invite link opened in a new tab).
  useEffect(() => {
    const rest = inviteRouteCode(pathname);
    if (!rest) return;
    const reading = readInvite(rest);
    let sessionId: string | null = null;
    if (reading.ok) {
      // This profile's own invite opens the chat that owns it, never a second one; one already joined by opens its chat.
      const outcome = classifyInvite(reading.keys);
      if (outcome.kind === "own") { sessionId = outcome.sessionId; showJoinNotice("join.own"); }
      else {
        try { sessionId = ensureSession(reading.keys); } catch { sessionId = null; }
        if (sessionId && outcome.kind === "joined") showJoinNotice("join.alreadyIn");
      }
    } else if (!rest.includes("/") && !/^ghostly1/i.test(rest) && loadSession(decodeURIComponent(rest))) return; // an ordinary chat address
    if (!sessionId) {
      // Whatever it was, it leaves the address bar and the history: it may hold a key.
      setInvalid(reading.ok ? "join.invalid" : INVITE_REFUSAL_MESSAGE[reading.reason]);
      navigate("/", { replace: true });
      return;
    }
    window.dispatchEvent(new Event("session-updated"));
    navigate(chatPath(sessionId), { replace: true });
  }, [pathname, navigate]);

  useEffect(() => {
    if (!invalid) return;
    const timer = setTimeout(() => setInvalid(null), 6000);
    return () => clearTimeout(timer);
  }, [invalid]);

  return invalid ? (
    <div role="alert" data-testid="invite-link-invalid" onClick={() => setInvalid(null)}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-danger shadow-xl cursor-pointer">
      {t(invalid)}
    </div>
  ) : null;
}

/** "You're already in this chat", or "This is your own invite" from a link: said over the chat it opened, for a moment. */
function JoinNotice() {
  const { t } = useI18n();
  const [notice, setNotice] = useState<JoinNoticeKey | null>(null);
  useEffect(() => onJoinNotice(setNotice), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  return notice ? (
    <div role="status" data-testid="join-notice" onClick={() => setNotice(null)}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-text-primary shadow-xl cursor-pointer">
      {t(notice)}
    </div>
  ) : null;
}

/**
 * A group's link opened in the app (`#/join/group1/…` or `#/join/group2/…`): it leaves the address at once, like an
 * invite; once the app is unlocked the engine joins and the group opens, saying it waits for the admin's app.
 */
function GroupLinkIntake() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const nav = useAppNavigation();
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
      .then(({ groupId }) => nav.conversation(groupPath(groupId)))
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : "This link to a group does not work"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nav` changes with every location
  }, [code, hasUnlocked]);
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
 * An address the intakes above take out of the history at once: an invite's keys, a group's link, a chat
 * this device does not have. Everything else opened directly gets home put under it (`useAnchorHome`).
 */
function isIntake(pathname: string): boolean {
  if (pathname.startsWith("/join/") || /^\/?ghostly1/i.test(pathname)) return true;
  const rest = pathname.match(/^\/chat\/(.+)$/)?.[1];
  return !!rest && (rest.includes("/") || !loadSession(decodeURIComponent(rest)));
}

function HomeAnchor() {
  useAnchorHome(isIntake);
  return null;
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
            <ProfileSwitchSplash />
            <HashRouter>
              <ErrorBoundary>
              <ChatLinkIntake />
              <JoinNotice />
              <GroupLinkIntake />
              <HomeAnchor />
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
                      <Route path="/settings/advanced" element={<AdvancedSettings />} />
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
