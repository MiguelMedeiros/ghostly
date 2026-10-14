import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AttentionFeedback } from "./components/AttentionFeedback";
import { NameStep } from "./components/NameStep";
import { OpenFailureNotice } from "./components/OpenFailureNotice";
import { App } from "./App";
import { Home } from "./pages/Home";
import { GroupChat } from "./pages/GroupChat";
import { SharePicker } from "./pages/SharePicker";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./contexts/I18nContext";
import { LockScreenProvider, useLockScreen } from "./contexts/LockScreenContext";
import { UpdateProvider } from "./contexts/UpdateContext";
import { LockScreen } from "./components/LockScreen";
import { ProfileSwitchSplash } from "./components/ProfileSwitchSplash";
import { PreUnlockRing } from "./components/PreUnlockRing";
import { LINK_CHATS_WAITING, NO_ROOM_FOR_CHAT, ensureSession, linkChatsWaiting, loadSession, type SessionKeys } from "./lib/storage";
import { useI18n, useT } from "./contexts/I18nContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { menuPage } from "./components/MenuPage";
import { ProfileGate } from "./components/ProfileUnavailable";
import { DeviceStandby } from "./components/DeviceStandby";
import { LimitedStartGate } from "./components/devices/LimitedStart";
import { useDeviceGate } from "./hooks/useDeviceGate";
import { JoinHost } from "./components/devices/JoinHost";
import { isDeviceCode, offerDeviceLink, readDeviceLink, takeDeviceLinkFromAddress } from "./lib/devices";
import { INVITE_REFUSAL_MESSAGE, chatPath, classifyInvite, inviteRouteCode, protocolLinkCode, readInvite } from "./lib/url";
import { onJoinNotice, showJoinNotice, type JoinNoticeKey } from "./lib/joinNotice";
import { onChatNotStored, reportChatNotStored } from "./lib/chatNotStored";
import { groupPath } from "./lib/groups";
import { engine } from "@ghostly/browser/platform/engine";
import { useAnchorHome, useAppNavigation } from "./hooks/useAppNavigation";
import { problemText, type Problem } from "./lib/problemText";
import { Notice } from "./components/ui/Notice";
import { watchWindowAway } from "./lib/windowAway";
import "./index.css";

// The pages of the menu, each loaded the first time it is opened (components/MenuPage.tsx).
const Settings = menuPage(() => import("./pages/Settings").then((m) => m.Settings));
const Services = menuPage(() => import("./pages/Services").then((m) => m.Services));
const Profile = menuPage(() => import("./pages/Profile").then((m) => m.Profile));
const Identities = menuPage(() => import("./pages/Identities").then((m) => m.Identities));
const Apps = menuPage(() => import("./pages/Apps").then((m) => m.Apps));
const Tasks = menuPage(() => import("./pages/Tasks").then((m) => m.Tasks));
const Wallet = menuPage(() => import("./pages/Wallet").then((m) => m.Wallet));

/**
 * A device code's link that names the profile, `#<profile>#ghostly1z…` (WISP 06 § Adding a device), as the router reads
 * it when the address changes while the app is open: the name as the path, the code as its hash. Null for anything else.
 */
function namedDeviceLink(pathname: string, hash: string): string | null {
  const named = `#${pathname.replace(/^\//, "")}${hash}`;
  const link = readDeviceLink(named);
  return link.profile && /^ghostly1/i.test(link.code) && isDeviceCode(link.code) ? named : null;
}

/**
 * An invite link, or a chat address from before chats were routed by session
 * id, carries the chat's keys. They leave the address at once, so they stay
 * out of the history: the address must not wait for the password. The chat
 * itself is made once the lock is passed, as a group's link is joined, and
 * only while few link-made chats still wait for an answer (`LINK_CHATS_WAITING`).
 */
function ChatLinkIntake() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { isLocked } = useLockScreen();
  const locked = useRef(isLocked);
  locked.current = isLocked;
  /** The invite a link brought while locked: the last one, kept in memory only. */
  const [held, setHeld] = useState<SessionKeys | null>(null);
  const [invalid, setInvalid] = useState<(typeof INVITE_REFUSAL_MESSAGE)[keyof typeof INVITE_REFUSAL_MESSAGE] | "join.invalid" | "join.tooManyLinks" | null>(null);

  const open = useCallback((keys: SessionKeys) => {
    // This profile's own invite opens the chat that owns it, never a second one; one already joined by opens its chat.
    const outcome = classifyInvite(keys);
    let sessionId: string | null;
    if (outcome.kind === "own") { sessionId = outcome.sessionId; showJoinNotice("join.own"); }
    else if (outcome.kind === "new" && linkChatsWaiting() >= LINK_CHATS_WAITING) {
      setInvalid("join.tooManyLinks");
      navigate("/", { replace: true });
      return;
    } else {
      try { sessionId = ensureSession(keys, { viaLink: true }); } catch (cause) {
        // A good invite the storage has no room for: said as that, never as a bad invite.
        if (cause instanceof Error && cause.message === NO_ROOM_FOR_CHAT) { reportChatNotStored(cause); navigate("/", { replace: true }); return; }
        sessionId = null;
      }
      if (sessionId && outcome.kind === "joined") showJoinNotice("join.alreadyIn");
    }
    if (!sessionId) {
      setInvalid("join.invalid");
      navigate("/", { replace: true });
      return;
    }
    window.dispatchEvent(new Event("session-updated"));
    navigate(chatPath(sessionId), { replace: true });
  }, [navigate]);

  // An effect, not a layout effect: the router starts listening in its own layout effect, after this
  // one's, and would miss a navigation made before it (an invite link opened in a new tab).
  useEffect(() => {
    // A device code's link that names the profile, opened while the app was open already: the join host takes it.
    const named = namedDeviceLink(pathname, hash);
    if (named) { offerDeviceLink(named); navigate("/", { replace: true }); return; }
    const rest = inviteRouteCode(pathname);
    if (!rest) return;
    // A device code opened while the app was open already (the address changed, no new page): the join host takes it.
    if (isDeviceCode(rest)) { offerDeviceLink(rest); navigate("/", { replace: true }); return; }
    const reading = readInvite(rest);
    if (reading.ok) {
      if (locked.current) { setHeld(reading.keys); navigate("/", { replace: true }); }
      else open(reading.keys);
      return;
    }
    if (protocolLinkCode(pathname) === null && !rest.includes("/") && !/^ghostly1/i.test(rest) && loadSession(decodeURIComponent(rest))) return; // an ordinary chat address
    // Whatever it was, it leaves the address bar and the history: it may hold a key.
    setInvalid(INVITE_REFUSAL_MESSAGE[reading.reason]);
    navigate("/", { replace: true });
  }, [pathname, hash, navigate, open]);

  useEffect(() => {
    if (!held || isLocked) return;
    setHeld(null);
    open(held);
  }, [held, isLocked, open]);

  useEffect(() => {
    if (!invalid) return;
    const timer = setTimeout(() => setInvalid(null), 6000);
    return () => clearTimeout(timer);
  }, [invalid]);

  return invalid ? (
    <div role="alert" data-testid="invite-link-invalid" onClick={() => setInvalid(null)}
      className="top-notice rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-danger shadow-xl cursor-pointer">
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
      className="top-notice rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-text-primary shadow-xl cursor-pointer">
      {t(notice)}
    </div>
  ) : null;
}

/**
 * A top notice there until closed: by its ×, by Escape, or by a tap on its words (not on its ⓘ, Copy or the details
 * they open). It sits over the sidebar's header, so it closes as the app's other top notices do. An Escape something
 * else answered (a menu, a popover) is not its own. The focus goes back where it was when it came (the New that could
 * not make a chat) when it was on the notice or nowhere, not to the page; one in a field or a menu stays there.
 */
function ClosableTopNotice({ problem, testId, onClose }: { problem: Problem; testId: string; onClose: () => void }) {
  const t = useT();
  const [back] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(() => {});
  close.current = () => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !!root.current?.contains(active);
    onClose();
    if (lost && back && back !== document.body && back.isConnected) back.focus();
  };
  useEffect(() => {
    // On the window: it hears the Escape after the document's listeners, a menu opened after the notice among them.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) close.current(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div ref={root} onClick={(e) => { if (!(e.target as Element).closest(`button, [data-testid="${testId}-details"]`)) close.current(); }}
      className="top-notice flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-panel-header py-2 ps-4 pe-2 shadow-xl">
      <Notice problem={problem} testId={testId} className="min-w-0 text-sm" />
      <button type="button" data-testid={`${testId}-close`} onClick={() => close.current()} aria-label={t("common.close")}
        className="-my-1 h-8 w-8 shrink-0 cursor-pointer rounded-md text-lg leading-none text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>
    </div>
  );
}

/**
 * A new chat the storage had no room for, made where no dialog says it (lib/chatNotStored.ts): what happened and what to
 * do, there until closed.
 */
function ChatNotStoredNotice() {
  const t = useT();
  const [problem, setProblem] = useState<Problem | null>(null);
  useEffect(() => onChatNotStored((cause) => setProblem(problemText(cause, t))), [t]);
  return problem ? <ClosableTopNotice problem={problem} testId="chat-not-stored" onClose={() => setProblem(null)} /> : null;
}

/**
 * A group's link opened in the app (`#/join/group1/…` or `#/join/group2/…`): it leaves the address at once, like an
 * invite; once the app is unlocked the engine joins and the group opens, saying it waits for the admin's app. A refusal
 * is a notice as JoinDialog shows one (a title, what to do, the engine's English behind the ⓘ), there until closed.
 */
function GroupLinkIntake() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const nav = useAppNavigation();
  const { hasUnlocked } = useLockScreen();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const t = useT();
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
      .catch((cause: unknown) => setProblem(cause instanceof Error ? problemText(cause, t) : { tone: "error", title: t("group.link.broken") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nav` changes with every location
  }, [code, hasUnlocked]);
  return problem ? <ClosableTopNotice problem={problem} testId="group-link-invalid" onClose={() => setProblem(null)} /> : null;
}

/**
 * An address the intakes above take out of the history at once: an invite's keys, a group's link, a chat
 * this device does not have. Everything else opened directly gets home put under it (`useAnchorHome`).
 */
function isIntake(pathname: string): boolean {
  if (pathname.startsWith("/join/") || /^\/?ghostly1/i.test(pathname) || protocolLinkCode(pathname) !== null) return true;
  // The app icon's shortcuts: the sidebar acts on them and takes them out of the history.
  if (pathname === "/new" || pathname === "/scan") return true;
  const rest = pathname.match(/^\/chat\/(.+)$/)?.[1];
  return !!rest && (rest.includes("/") || !loadSession(decodeURIComponent(rest)));
}

function HomeAnchor() {
  // A named device link is an intake too: home is not put under it, and its name is never kept as a route.
  const { hash } = useLocation();
  useAnchorHome((pathname) => isIntake(pathname) || !!namedDeviceLink(pathname, hash));
  return null;
}

/**
 * A chat has no route element of its own: `App` keeps it loaded across a trip
 * to Settings, so a call it holds is not hung up on the way.
 */
const ChatRoute = () => null;

/**
 * Nothing of the app exists until the password has been entered once, but a chat whose call rings meanwhile
 * (`PreUnlockRing`, hidden and inert). When it locks again later the app stays mounted (a call keeps going) but can be
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

/**
 * The app's router. A move to another page is drawn at once, not as a transition: the engine's state comes several
 * times a second, each time a sync render, and each one started a transition's render over. Leaving a long chat still
 * drawing its older rows (transitions too, before the row window) waited behind them: seconds on a slow machine.
 */
export function AppRouter({ children }: { children: ReactNode }) {
  return <HashRouter useTransitions={false}>{children}</HashRouter>;
}

/** The whole Ghostly UI. Desktop and Browser both render this; only the platform modules differ. */
export function Root() {
  // A device code opened as a link leaves the address before the router, or anything else, reads it (WISP 06).
  useState(takeDeviceLinkFromAddress);
  // The loops rest while the window is hidden or behind others (index.css `:root[data-away]`).
  useEffect(watchWindowAway, []);
  // Not the active device for this profile (WISP 06 § The gate): the standby screen, and nothing of the profile. No
  // router and no link intake either: an invite opened here would be written into a copy that must stay as it is.
  const standby = useDeviceGate();
  // Device-link-only mode starts as the engine does, before the lock is passed; it is what the screen hears from.
  useEffect(() => { if (standby) void engine.connect().catch(() => {}); }, [standby]);
  return (
    <SettingsProvider>
      <ThemeProvider>
        <I18nProvider>
          <LockScreenProvider>
            <LockScreen />
            <ProfileSwitchSplash />
            {standby ? <LockGate><DeviceStandby gate={standby} /></LockGate> : (
            <AppRouter>
              <ErrorBoundary>
              <ChatLinkIntake />
              <JoinNotice />
              <ChatNotStoredNotice />
              <OpenFailureNotice />
              <GroupLinkIntake />
              <HomeAnchor />
              {/* A call that rings before the first unlock: shown on the lock screen (WISP 601 § Locked). */}
              <PreUnlockRing />
              <LockGate>
                {/* Asking for updates says this device runs Ghostly: not before the password. */}
                <UpdateProvider>
                  {/* A profile whose database did not open shows why, and nothing that looks alive. */}
                  <ProfileGate>
                  {/* A start that could not check which device is active asks first (WISP 06 § When a device checks). */}
                  <LimitedStartGate>
                  <AttentionFeedback />
                  <NameStep />
                  <Routes>
                    {/* What the intakes above take out of the history at once (a group's link, an invite code, a
                        web+ghostly: link): nothing drawn for them, as before, and no "No routes matched" warning. */}
                    <Route path="/join/*" element={null} />
                    <Route path="/:intake" element={null} />
                    <Route element={<App />}>
                      <Route path="/" element={<Home />} />
                      <Route path="/chat/*" element={<ChatRoute />} />
                      <Route path="/group/:groupId" element={<GroupChat />} />
                      {/* One route for the menu and its sections, so moving between them keeps the page as it is. */}
                      <Route path="/settings/:section?" element={<Settings />} />
                      <Route path="/wallet" element={<Wallet />} />
                      <Route path="/services" element={<Services />} />
                      <Route path="/profile" element={<Profile />} />
                      <Route path="/identities" element={<Identities />} />
                      {/* Mini-apps (WISP 1200): the page sends the person home where Apps does not show. */}
                      <Route path="/apps" element={<Apps />} />
                      <Route path="/tasks" element={<Tasks />} />
                      <Route path="/share" element={<Navigate to="/services" replace />} />
                      {/* The installed web app: what another app shared, and the icon's shortcuts (manifest.json). */}
                      <Route path="/shared" element={<SharePicker />} />
                      <Route path="/new" element={<Home />} />
                      <Route path="/scan" element={<Home />} />
                    </Route>
                  </Routes>
                  </LimitedStartGate>
                  </ProfileGate>
                </UpdateProvider>
              </LockGate>
              </ErrorBoundary>
            </AppRouter>
            )}
            {/* "Add this device to my profile", and a device code opened as a link: over the chat list, the home pane
                or the standby screen alike, and kept across the gate's answer. */}
            <LockGate><JoinHost standby={!!standby} /></LockGate>
          </LockScreenProvider>
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}
