import { useState, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import { useUpdate } from "../contexts/UpdateContext";
import { updateFailure } from "../lib/updateFailure";
import { canInstall, isAppleMobile, isMacSafari, startInstall, useInstallState } from "../lib/installPrompt";
import { browserPrompts, reconsiderPersist, requestPersist, useStorageProtection } from "../lib/storagePersistence";
import { storageBreakdown, useDesktopStorage } from "../lib/desktopStorage";
import { pushPlatform, pushUnavailable, setWake, useWakeOn } from "../lib/wakePush";
import { noticePlace, noticeSettings, notificationPermission, openNoticeSettings, requestNotifications, type NoticePermission } from "../lib/notifications";
import { getVersion } from "@tauri-apps/api/app";
import { NetworkSettings } from "../components/NetworkSettings";
import { ForkRows } from "../components/devices/Forks";
import { DomainProofSettings } from "../components/DomainProofSettings";
import { MediaSettings } from "../components/MediaSettings";
import { Block, ButtonGroup, Field, FieldGrid, InputGroup, LinkRow, Page, Row, Section } from "../components/layout";
import { ColorSwatches } from "../components/ColorSwatches";
import { ProfileBadge } from "../components/ProfileBadge";
import { useIsMobile } from "../hooks/useIsMobile";
import { useMyAvatar } from "../hooks/useAvatars";
import { currentProfile, listProfiles } from "../lib/profiles";
import { openProfileSwitcher } from "../hooks/useProfileSwitcher";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { Button, Switch } from "../components/wallet/ui";
import { setLoadPublicProfiles, useLoadPublicProfiles } from "../hooks/usePublicProfileRequest";
import { setSendTyping, useSendTyping } from "../hooks/useTyping";
import { Select } from "../components/ui/Select";
import { Toast } from "../components/ui/Toast";
import { useToast } from "../hooks/useToast";
import { FieldError } from "../components/ui/FieldError";
import { focusToRetype } from "../lib/focus";
import { CATEGORY_PREVIEW, categoryOn } from "../lib/cues";
import { playSound } from "../lib/sounds";
import { clearAllData } from "../lib/clearData";
import { lockPasswordMin, useDeviceSet } from "../lib/devices";
import { useEngineState } from "../lib/identities";
import { engine } from "@ghostly/browser/platform/engine";
import {
  hashPassword,
  verifyPassword,
  getStorageUsage,
  formatBytes,
  LANGUAGE_OPTIONS,
  COLOR_SCHEME_OPTIONS,
  APP_WEBSITE,
  APP_LICENSE,
  CUE_CATEGORIES,
  DEFAULT_CUES,
  type ColorScheme,
  type Language,
} from "../lib/settings";
import { deleteAllSessions, listSessions } from "../lib/storage";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { peekEnabled, peekNotifies } from "../lib/profilePeek";
import { externalLinkProps, isDesktopApp } from "../lib/externalLink";
import { errorText } from "../lib/errorText";
import { hasMediaDevices } from "../lib/mediaDevices";
import { navOnly, readNav } from "../lib/navigation";
import { SECTION_TITLE, SETTINGS_SECTIONS, isOldSection, sectionInView, settingsPath, settingsSection, type SettingNeeds, type SettingsSection } from "../lib/settingsSections";
import { SettingsIndex, SettingsMenu } from "../components/settings/SettingsMenu";

/** The fields of the lock password form, each with its own error line. */
type PasswordField = "current" | "new" | "confirm";

/** What "Clear all data" erases, as its confirmation lists it (lib/clearData.ts). */
const CLEAR_ITEMS = ["chats", "groups", "apps", "profile", "identities", "settings", "storage"] as const;

/** Which sections are drawn: on a phone the one its address names (none on the menu), on a wider screen all of them. */
interface SectionView { phone: boolean; section: SettingsSection | null }

/**
 * One section's options. On a phone it is the whole screen, whose title already names it: its first card's
 * heading is left to screen readers there.
 */
function SettingsGroup({ id, view, children }: { id: SettingsSection; view: SectionView; children: ReactNode }) {
  if (view.phone && view.section !== id) return null;
  if (id === "media" && !hasMediaDevices()) return null; // no devices to pick here: no empty space for them either
  return (
    <div id={`settings-section-${id}`} data-settings-section={id} className={`space-y-6 scroll-mt-2 ${view.phone ? "[&>section:first-child>h2]:sr-only" : ""}`}>
      {children}
    </div>
  );
}

export function Settings() {
  const nav = useAppNavigation();
  const { settings, updateColorScheme, updateLanguage, updateLockScreen, updateNotifications, updateDefaultNickname,
    updateReduceMotion, updateChatListDensity, updateCheckForUpdates, updateLinkPreviews, updateProfilePeek, randomizeNickname } =
    useSettings();
  const { t } = useI18n();
  const { lock } = useLockScreen();
  const update = useUpdate();
  const install = useInstallState();
  // Wake-up push (WISP 401 § Wake-up push): the installed web app only.
  const canWake = !!pushPlatform();
  const wakeOn = useWakeOn();
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeError, setWakeError] = useState("");
  const changeWake = async (on: boolean) => {
    setWakeBusy(true);
    setWakeError("");
    try { await setWake(on); } catch (e) { setWakeError(errorText(e, t)); } finally { setWakeBusy(false); }
  };
  const isMobile = useIsMobile();
  const profile = currentProfile();
  const myAvatar = useMyAvatar();
  const canSwitch = !!useServicesPlatform()?.features.profiles;
  const peekOn = peekEnabled(settings, isDesktopApp());
  const loadPublicProfiles = useLoadPublicProfiles();
  const sendTyping = useSendTyping();

  // Which section the address names (`/settings/appearance`); an old address (`/settings/advanced`) leads to its new place.
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const section = settingsSection(params.section);
  const view: SectionView = { phone: isMobile, section };
  useEffect(() => {
    // Once the entry knows what is under it (a deep link is given that first), it takes the new address in its place.
    if (isOldSection(params.section) && section && readNav(location.state)) void navigate(settingsPath(section), { replace: true, state: location.state });
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps -- once per entry
  // A wide screen: the index shows the section in view, and an address naming one scrolls to it.
  const content = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState<SettingsSection>(section ?? SETTINGS_SECTIONS[0]);
  const picked = useRef<SettingsSection | null>(null);
  // The section picked in the index or named by the address: marked while in view, until the page is scrolled by hand.
  const wanted = useRef<SettingsSection | null>(section);
  useEffect(() => {
    if (isMobile || !section) return;
    wanted.current = section;
    if (picked.current === section) { picked.current = null; return; } // picked in the index: already on its way there
    document.getElementById(`settings-section-${section}`)?.scrollIntoView({ block: "start" });
    setInView(section);
  }, [section, isMobile]);
  useEffect(() => {
    const body = content.current?.closest<HTMLElement>("[data-page-body]");
    if (isMobile || !body) return;
    const onScroll = () => {
      const view = body.getBoundingClientRect();
      const boxes = [...body.querySelectorAll<HTMLElement>("[data-settings-section]")].map((group) => {
        const box = group.getBoundingClientRect();
        return { section: group.dataset.settingsSection as SettingsSection, top: box.top, bottom: box.bottom };
      });
      const atEnd = body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
      setInView(sectionInView(boxes, view.top + 48, view.bottom, atEnd, wanted.current));
    };
    // Scrolled by hand (wheel, touch, keys, the scroll bar): the section at the top is marked again.
    const byHand = (event: Event) => { if (event.type !== "pointerdown" || event.target === body) wanted.current = null; };
    const hands = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    body.addEventListener("scroll", onScroll, { passive: true });
    for (const type of hands) body.addEventListener(type, byHand, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
      for (const type of hands) body.removeEventListener(type, byHand);
    };
  }, [isMobile]);
  const pick = (to: SettingsSection) => {
    wanted.current = to;
    document.getElementById(`settings-section-${to}`)?.scrollIntoView({ block: "start", behavior: settings.reduceMotion ? "auto" : "smooth" });
    setInView(to);
    // The page stays where it is; its address names the section, so a reload comes back to it.
    if (to === section) return;
    picked.current = to;
    void navigate(settingsPath(to), { replace: true, state: navOnly(location.state) });
  };

  const [lockEnabled, setLockEnabled] = useState(settings.lockScreen.enabled);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    settings.lockScreen.timeoutMinutes
  );
  // What a password or data action says: a floating card near where the person is looking, not a line at the top of the page.
  const notice = useToast();
  // A refused password: which field, and why, shown right under it.
  const [passwordError, setPasswordError] = useState<{ field: PasswordField; text: string } | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const passwordId = useId();
  const passwordInputs = { current: useRef<HTMLInputElement>(null), new: useRef<HTMLInputElement>(null), confirm: useRef<HTMLInputElement>(null) };
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  // The form opened by the person (the lock switch, Change password): its first field takes the focus, and the keyboard comes up.
  const focusPasswordForm = useRef(false);
  const openPasswordForm = () => { focusPasswordForm.current = true; setShowPasswordForm(true); };
  useLayoutEffect(() => {
    if (!showPasswordForm || !focusPasswordForm.current) return;
    focusPasswordForm.current = false;
    (passwordInputs.current.current ?? passwordInputs.new.current)?.focus();
  }, [showPasswordForm]); // eslint-disable-line react-hooks/exhaustive-deps -- the refs are read when it opens
  const [storageInfo, setStorageInfo] = useState({ used: 0, keys: 0 });
  // Whether the browser may clear this device's storage (lib/storagePersistence). Nothing on Desktop: no browser evicts it.
  const { protection, estimate } = useStorageProtection();
  // The Desktop's own count (lib/desktopStorage): its WebView's storage plus the profile's files on disk.
  const desktopStorage = useDesktopStorage(isDesktopApp(), storageInfo.used);
  const desktopUsed = desktopStorage && storageBreakdown(desktopStorage);
  const [protecting, setProtecting] = useState(false);
  const [confirmClearData, setConfirmClearData] = useState(false);
  const [confirmDeleteChats, setConfirmDeleteChats] = useState(false);
  const [chatCount, setChatCount] = useState(0);
  const [noticePermission, setNoticePermission] = useState<NoticePermission>("default");
  const [requestingNotice, setRequestingNotice] = useState(false);
  useEffect(() => {
    const refresh = () => { void notificationPermission().then(setNoticePermission); };
    refresh(); window.addEventListener("focus",refresh);
    return () => window.removeEventListener("focus",refresh);
  }, []);
  const toggleNotices = async () => {
    if (settings.notifications.systemEnabled) { updateNotifications({systemEnabled:false}); return; }
    setRequestingNotice(true);
    const permission = await requestNotifications();
    setNoticePermission(permission);
    updateNotifications({systemEnabled:permission==="granted"});
    // Allowed to notify: a browser that refused to protect the storage before may say yes now.
    if (permission === "granted") void reconsiderPersist();
    setRequestingNotice(false);
  };
  const [appVersion, setAppVersion] = useState("0.0.0");

  const hasPassword = !!settings.lockScreen.passwordHash;
  // A profile on several devices (WISP 06) keeps a lock password of 8 characters or more: it cannot be shortened,
  // turned off or removed here. One with no device set keeps today's rule.
  const devices = useDeviceSet(0);
  /**
   * Whether the profile has a device set, for a password action: asked now when the page's read has not answered yet
   * (an engine still starting), so a profile on one device is not held to the rule of a set. When the call fails, as
   * if there were one: the stricter rule.
   */
  const hasDeviceSet = async (): Promise<boolean> => {
    if (devices) return devices.state !== "single";
    return engine.call("deviceSet").then((view) => view.state !== "single", () => true);
  };
  // The push address contacts hold is another device's (WISP 06 § Push and the phone): this one is not woken by it.
  const engineState = useEngineState();
  const wakeAway = engineState?.wakeOwner === "away" && !!engineState.settings.wake;
  const wakeAwayDevice = wakeAway ? devices?.devices.find((device) => device.key === engineState?.settings.wake?.device)?.name : undefined;

  useEffect(() => {
    setStorageInfo(getStorageUsage());
    setChatCount(listSessions().length);
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.0.0"));
  }, []);

  const handleColorSchemeChange = (scheme: ColorScheme) => {
    updateColorScheme(scheme);
  };

  const handleLanguageChange = (language: Language) => {
    updateLanguage(language);
  };

  const handleTimeoutChange = (minutes: number) => {
    setTimeoutMinutes(minutes);
    updateLockScreen({ timeoutMinutes: minutes });
  };

  const handleLockToggle = async () => {
    if (!lockEnabled && !hasPassword) {
      openPasswordForm();
      return;
    }

    if (lockEnabled && (await hasDeviceSet())) {
      notice.show(t("devices.password.keep"));
      return;
    }
    if (lockEnabled) {
      setLockEnabled(false);
      updateLockScreen({ enabled: false });
    } else {
      setLockEnabled(true);
      updateLockScreen({ enabled: true });
    }
  };

  /** A password refused: said under its field and in the floating card, and the field is ready to be typed again. */
  const refusePassword = (which: PasswordField, text: string, title: string) => {
    setPasswordError({ field: which, text });
    notice.show(text, { title });
    focusToRetype(passwordInputs[which].current);
  };

  const handleSetPassword = async () => {
    const title = hasPassword ? t("settings.passwordNotChanged") : t("settings.passwordNotSet");
    setPasswordError(null);
    setPasswordBusy(true);
    try {
      const deviceSet = await hasDeviceSet();
      // The current one first: nothing changes for someone who does not know it.
      if (hasPassword && !(await verifyPassword(currentPassword, settings.lockScreen.passwordHash!))) {
        refusePassword("current", t("settings.incorrectPassword"), title);
        return;
      }
      if (newPassword.length < lockPasswordMin(deviceSet)) {
        refusePassword("new", deviceSet ? t("devices.password.keep") : t("settings.passwordTooShort"), title);
        return;
      }
      if (newPassword !== confirmPassword) {
        refusePassword("confirm", t("settings.passwordMismatch"), title);
        return;
      }

      const hash = await hashPassword(newPassword);
      updateLockScreen({
        enabled: true,
        passwordHash: hash,
      });
      // A profile on several devices: a pull proves this password now, so its verifier is made again while it is typed (WISP 06).
      let verifierFailed = false;
      if (deviceSet) await engine.call("deviceHandoffVerifier", { password: newPassword, current: hasPassword ? currentPassword : undefined }).catch(() => { verifierFailed = true; });

      setLockEnabled(true);
      setNewPassword("");
      setConfirmPassword("");
      setCurrentPassword("");
      setShowPasswordForm(false);
      // The lock changed, and a pull would still need a proof that could not be made: said, not hidden.
      if (verifierFailed) notice.show(t("devices.handoff.verifierFailed"));
      else notice.show(hasPassword ? t("settings.passwordChanged") : t("settings.passwordSet"), { tone: "success" });
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleRemovePassword = async () => {
    const title = t("settings.passwordNotRemoved");
    setPasswordError(null);
    setPasswordBusy(true);
    try {
      if (await hasDeviceSet()) {
        notice.show(t("devices.password.keep"), { title });
        return;
      }
      if (hasPassword && !(await verifyPassword(currentPassword, settings.lockScreen.passwordHash!))) {
        refusePassword("current", t("settings.incorrectPassword"), title);
        return;
      }

      updateLockScreen({
        enabled: false,
        passwordHash: null,
      });

      setLockEnabled(false);
      setCurrentPassword("");
      setShowPasswordForm(false);
      notice.show(t("settings.passwordRemoved"), { tone: "success" });
    } finally {
      setPasswordBusy(false);
    }
  };

  const field = "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent transition-colors";
  const lockOn = lockEnabled && hasPassword;
  const systemOn = settings.notifications.systemEnabled && noticePermission === "granted";
  const systemSettings = noticeSettings();
  const deniedHint = { macos: "settings.noticesDeniedMac", windows: "settings.noticesDeniedWindows", system: "settings.noticesDeniedSystem",
    extension: "settings.noticesDeniedExtension", web: "settings.noticesDenied" } as const;
  const closePasswordForm = () => { setShowPasswordForm(false); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setPasswordError(null); };
  /** One of the password fields, wired to its error: `aria-invalid`, `aria-describedby`, and the line under it. */
  const passwordField = (which: PasswordField, label: string, value: string, change: (value: string) => void) => {
    const error = passwordError?.field === which ? passwordError.text : null;
    const errorId = `${passwordId}-${which}-error`;
    return (
      <div>
        <label className="block text-sm text-text-secondary">
          {label}
          <input ref={passwordInputs[which]} type="password" value={value} data-testid={`settings-password-${which}`}
            autoComplete={which === "current" ? "current-password" : "new-password"}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            onChange={(e) => { change(e.target.value); if (passwordError?.field === which) setPasswordError(null); }}
            className={`${field} mt-1 aria-invalid:border-danger aria-invalid:focus:ring-danger`} />
        </label>
        <FieldError id={errorId} testId={`settings-password-${which}-error`}>{error}</FieldError>
      </div>
    );
  };
  const deleteChats = () => {
    deleteAllSessions();
    setConfirmDeleteChats(false);
    setChatCount(0);
    setStorageInfo(getStorageUsage());
    window.dispatchEvent(new Event("session-updated"));
    notice.show(t("sidebar.deleteAllChats"), { tone: "success" });
  };
  const clearData = async () => {
    setConfirmClearData(false);
    notice.show(t("settings.dataCleared"), { tone: "success" });
    await clearAllData();
    setStorageInfo(getStorageUsage());
    // The running peer still holds what was just deleted; start it over.
    window.location.replace(window.location.pathname);
  };

  // The page's floating card, over the menu, a section or the whole page alike.
  const overlay = <Toast toast={notice.toast} onDismiss={notice.dismiss} place="page" testId="settings-notice" />;

  // First while there is something to install (the web app only): it goes once installed.
  const installApp = canInstall(install) && (
    <Section title={t("pwa.installTitle")}>
      <Row label={t(install === "ios" ? "pwa.iosLabel" : install === "dock" ? "pwa.dockLabel" : "pwa.installLabel")}
        hint={t(install === "ios" ? "pwa.iosHint" : install === "dock" ? "pwa.dockHint" : "pwa.installHint")}>
        <Button variant="primary" data-testid="install-app" onClick={startInstall}>{t("pwa.install")}</Button>
      </Row>
    </Section>
  );

  // What this device has: the options it lacks are not offered, nor found by the search.
  const has = (needs: SettingNeeds) => needs === "profiles" ? canSwitch : needs === "updates" ? update.supported
    : needs === "wake" ? canWake : hasMediaDevices();
  const shown = (id: SettingsSection) => id !== "media" || hasMediaDevices();

  if (isMobile && !section) {
    // A phone: the menu of sections, each opened on a screen of its own, under the profile's own line.
    const scheme = t(`settings.colorSchemes.${settings.colorScheme}` as const);
    const language = LANGUAGE_OPTIONS.find((option) => option.value === settings.language)?.native;
    const summary: Partial<Record<SettingsSection, ReactNode>> = {
      profile: settings.defaultNickname || undefined,
      appearance: [scheme, language].filter(Boolean).join(", "),
      notifications: t("settings.notificationsHint"),
      media: t("settings.mediaHint"),
      privacy: t("settings.privacyHint"),
      network: t("settings.networkHint"),
      storage: desktopUsed ? formatBytes(desktopUsed.total, t) : formatBytes(estimate?.used ?? storageInfo.used, t),
      about: update.update ? t("updates.available", { version: update.update.version }) : `${t("settings.version")} ${appVersion}`,
    };
    return (
      <Page title={t("settings.title")} width="md" testId="settings-page" overlay={overlay}>
        {installApp}
        <SettingsMenu summary={summary} shown={shown} has={has} onOpen={(id) => nav.open(settingsPath(id))} top={
          <div className="bg-surface rounded-xl divide-y divide-border">
            {/* A phone has no account bar, and Profile no tab of its own (the bar is full): this is the way there. */}
            <LinkRow testId="settings-profile-link" leading={<ProfileBadge entry={profile} size={36} avatar={myAvatar} />}
              label={profile.name} hint={t("settings.profileLinkHint")} onClick={() => nav.open("/profile")} />
            {/* The account switcher, where a phone's tab bar holds it (holding Settings opens it too). */}
            {canSwitch && (
              <LinkRow testId="settings-profile-switch" label={t("profileSwitcher.title")} hint={t("profileSwitcher.holdHint")}
                value={listProfiles().length > 1 ? listProfiles().length : undefined} onClick={openProfileSwitcher} />
            )}
          </div>
        } />
      </Page>
    );
  }

  const groups = (<>
      <SettingsGroup id="profile" view={view}>
      <Section title={t("settings.profile")}>
        {/* WISP 04 § Checking other profiles: reads only; on for Desktop, off for the web and the extension unless turned on. */}
        {canSwitch && (
          <Row label={t("settings.profilePeek")} hint={t("settings.profilePeekHint")} info={t("settings.profilePeekInfo")} testId="settings-profile-peek-row">
            <Switch testId="settings-profile-peek" label={t("settings.profilePeek")} checked={peekOn} onChange={(on) => updateProfilePeek({ enabled: on })} />
          </Row>
        )}
        {canSwitch && peekOn && (
          <Row label={t("settings.profilePeekNotify")} hint={t("settings.profilePeekNotifyHint")} testId="settings-profile-peek-notify-row">
            <Switch testId="settings-profile-peek-notify" label={t("settings.profilePeekNotify")} checked={peekNotifies(settings)} onChange={(on) => updateProfilePeek({ notify: on })} />
          </Row>
        )}
        <Field label={t("settings.defaultNickname")} hint={t("settings.defaultNicknameHint")} htmlFor="settings-nickname">
          <InputGroup>
            <input id="settings-nickname" type="text" value={settings.defaultNickname} onChange={(e) => updateDefaultNickname(e.target.value)}
              placeholder={t("settings.nicknamePlaceholder")} maxLength={20} className={field} />
            <button onClick={randomizeNickname} title={t("settings.randomizeName")} aria-label={t("settings.randomizeName")}
              className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt transition-colors cursor-pointer">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </InputGroup>
        </Field>
      </Section>
      </SettingsGroup>

      <SettingsGroup id="appearance" view={view}>
      <Section title={t("settings.appearance")}>
        <Row label={t("settings.colorTheme")}>
          <ColorSwatches label={t("settings.colorTheme")} testIdPrefix="settings-theme" />
        </Row>
        <Row label={t("settings.colorScheme")}>
          <div role="group" aria-label={t("settings.colorScheme")} className="flex flex-wrap gap-1 bg-surface-alt rounded-lg p-1">
            {COLOR_SCHEME_OPTIONS.map((option) => (
              <button key={option.value} onClick={() => handleColorSchemeChange(option.value)} aria-pressed={settings.colorScheme === option.value}
                className={`flex items-center gap-1 px-3 min-h-8 rounded-md text-sm whitespace-nowrap transition-colors cursor-pointer ${settings.colorScheme === option.value ? "bg-accent text-on-accent" : "text-text-secondary hover:text-text-primary"}`}>
                {option.value === "light" && (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <circle cx="12" cy="12" r="5" strokeWidth="2" />
                    <path strokeWidth="2" strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                )}
                {option.value === "dark" && (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
                {option.value === "system" && (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                {t(`settings.colorSchemes.${option.value}` as const)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("settings.chatListDensity")}>
          <div role="group" aria-label={t("settings.chatListDensity")} data-testid="chat-list-density" className="flex flex-wrap gap-1 bg-surface-alt rounded-lg p-1">
            {(["compact", "comfortable"] as const).map((density) => (
              <button key={density} onClick={() => updateChatListDensity(density)} aria-pressed={settings.chatListDensity === density} data-density={density}
                className={`px-3 min-h-8 rounded-md text-sm whitespace-nowrap transition-colors cursor-pointer ${settings.chatListDensity === density ? "bg-accent text-on-accent" : "text-text-secondary hover:text-text-primary"}`}>
                {t(`settings.chatListDensities.${density}` as const)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("settings.language")}>
          <Select fit aria-label={t("settings.language")} data-testid="settings-language" value={settings.language} onChange={handleLanguageChange}
            options={LANGUAGE_OPTIONS.map((option) => ({ value: option.value, label: option.native, description: option.label === option.native ? undefined : option.label }))} />
        </Row>
        <Row label={t("settings.reduceMotion")} hint={t("settings.reduceMotionHint")}>
          <Switch testId="settings-reduce-motion" label={t("settings.reduceMotion")} checked={settings.reduceMotion} onChange={(on) => updateReduceMotion(on)} />
        </Row>
      </Section>
      </SettingsGroup>

      <SettingsGroup id="notifications" view={view}>
      <Section title={t("settings.notifications")}>
        <Row label={t("settings.notificationSounds")} hint={t("settings.notificationSoundsDescription")}>
          <Switch testId="settings-sounds" label={t("settings.notificationSounds")} checked={settings.notifications.soundEnabled} onChange={(on) => updateNotifications({ soundEnabled: on })} />
        </Row>
        {CUE_CATEGORIES.map((category) => {
          const name = t(`settings.cues.${category}` as const), off = !settings.notifications.soundEnabled;
          return (
            <Row key={category} label={name} hint={t(`settings.cues.${category}Hint` as const)} testId={`settings-cues-${category}-row`}>
              <button type="button" data-testid={`settings-cues-${category}-preview`} disabled={off} onClick={() => playSound(CATEGORY_PREVIEW[category])}
                aria-label={t("settings.cues.preview", { name })} title={t("settings.cues.preview", { name })}
                className="grid place-items-center w-8 h-8 rounded-full text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
              </button>
              <Switch testId={`settings-cues-${category}`} label={name} disabled={off} checked={categoryOn(category, { ...settings.notifications, soundEnabled: true })}
                onChange={(on) => updateNotifications({ cues: { ...DEFAULT_CUES, ...settings.notifications.cues, [category]: on } })} />
            </Row>
          );
        })}
        <Row label={t("settings.systemNotifications")} testId="settings-system-notifications-row"
          hint={<span role="status">{noticePermission === "denied" ? t(deniedHint[noticePlace()])
            : noticePermission === "unavailable" ? t("settings.noticesUnavailable") : noticePermission === "misplaced" ? t("settings.noticesMisplaced") : t("settings.noticesRunning")}</span>}>
          {noticePermission === "denied" && systemSettings && (
            <Button data-testid="settings-notification-settings" onClick={() => void openNoticeSettings()}>{t("settings.noticesOpenSettings")}</Button>
          )}
          <Switch testId="settings-system-notifications" label={t("settings.systemNotifications")} checked={systemOn} disabled={requestingNotice} onChange={() => void toggleNotices()} />
        </Row>
        {canWake && (
          <Row label={t("pwa.wake")} testId="settings-wake-row" info={t("pwa.wakeInfo")}
            hint={<span role="status" data-testid="settings-wake-hint">{wakeError || (wakeAway ? (wakeAwayDevice ? t("pwa.wakeAway", { device: wakeAwayDevice }) : t("pwa.wakeAwayUnnamed")) : t(wakeOn ? "pwa.wakeOnHint" : "pwa.wakeHint"))}</span>}>
            {wakeOn && <Button data-testid="settings-wake-rotate" disabled={wakeBusy} onClick={() => void changeWake(true)}>{t("pwa.wakeRotate")}</Button>}
            <Switch testId="settings-wake" label={t("pwa.wake")} checked={wakeOn} disabled={wakeBusy} onChange={(on) => void changeWake(on)} />
          </Row>
        )}
        {!canWake && pushUnavailable() && (
          <Row label={t("pwa.wake")} testId="settings-wake-unavailable" hint={<span role="status">{t("pwa.wakeUnavailable")}</span>} />
        )}
      </Section>
      </SettingsGroup>

      <SettingsGroup id="media" view={view}>
      <MediaSettings />
      </SettingsGroup>

      <SettingsGroup id="privacy" view={view}>
      <Section title={t("settings.security")}>
        <Row label={t("settings.linkPreviews")} hint={t("settings.linkPreviewsHint")} info={t("settings.linkPreviewsInfo")} testId="settings-link-previews-row">
          <Switch testId="settings-link-previews" label={t("settings.linkPreviews")} checked={settings.linkPreviews} onChange={(on) => updateLinkPreviews(on)} />
        </Row>
        <Row label={t("settings.sendTyping")} hint={t("settings.sendTypingHint")} testId="settings-send-typing-row">
          <Switch testId="settings-send-typing" label={t("settings.sendTyping")} checked={sendTyping} onChange={(on) => void setSendTyping(on).catch(() => {})} />
        </Row>
        <Row label={t("settings.publicProfiles")} hint={t("settings.publicProfilesHint")} info={t("settings.publicProfilesInfo")} testId="settings-public-profiles-row">
          <Switch testId="settings-public-profiles" label={t("settings.publicProfiles")} checked={loadPublicProfiles} onChange={(on) => void setLoadPublicProfiles(on).catch(() => {})} />
        </Row>
        <Row label={t("settings.lockScreen")} hint={t("settings.lockScreenDescription")}>
          {lockOn && (
            <Button data-testid="settings-lock-now" onClick={() => { lock(); nav.home(); }} className="inline-flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              {t("settings.lockNow")}
            </Button>
          )}
          <Switch testId="settings-lock" label={t("settings.lockScreen")} checked={lockOn} onChange={() => void handleLockToggle()} />
        </Row>
        {hasPassword && (
          <Row label={t("settings.timeout")}>
            <Select fit aria-label={t("settings.timeout")} data-testid="settings-timeout" value={String(timeoutMinutes)} onChange={(v) => handleTimeoutChange(Number(v))}
              options={([1, 5, 15, 30, 60] as const).map((m) => ({ value: String(m), label: t(`settings.timeoutOptions.${m}`) }))} />
          </Row>
        )}
        {hasPassword && (
          <Row label={t("settings.password")}>
            <Button data-testid="settings-password-edit" aria-expanded={showPasswordForm} onClick={() => (showPasswordForm ? closePasswordForm() : openPasswordForm())}>
              {showPasswordForm ? t("common.close") : t("settings.passwordEdit")}
            </Button>
          </Row>
        )}
        {showPasswordForm && (
          <Block testId="settings-password-form">
            {hasPassword && passwordField("current", t("settings.currentPassword"), currentPassword, setCurrentPassword)}
            <FieldGrid>
              {passwordField("new", t("settings.newPassword"), newPassword, setNewPassword)}
              {passwordField("confirm", t("settings.confirmPassword"), confirmPassword, setConfirmPassword)}
            </FieldGrid>
            <ButtonGroup>
              <Button variant="primary" disabled={passwordBusy} onClick={() => void handleSetPassword()}>
                {hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
              </Button>
              {hasPassword && <Button variant="danger" disabled={passwordBusy} onClick={() => void handleRemovePassword()}>{t("settings.removePassword")}</Button>}
              {!hasPassword && <Button onClick={closePasswordForm}>{t("common.cancel")}</Button>}
            </ButtonGroup>
          </Block>
        )}
      </Section>
      </SettingsGroup>

      {/* How this client reaches the network, and how it checks contacts' domain proofs (once Settings → Advanced). */}
      <SettingsGroup id="network" view={view}>
        <NetworkSettings />
        <DomainProofSettings />
      </SettingsGroup>

      <SettingsGroup id="storage" view={view}>
      <Section title={t("settings.data")}>
        <Row label={t("settings.storageUsed")} testId="settings-storage-used"
          value={desktopUsed ? formatBytes(desktopUsed.total, t) : estimate ? t("settings.storageOf", { used: formatBytes(estimate.used, t), quota: formatBytes(estimate.quota, t) }) : formatBytes(storageInfo.used, t)}
          info={desktopUsed ? <span data-testid="settings-storage-parts">
            {desktopUsed.parts.map((part) => <span key={part.key} className="block">{t(`settings.storageParts.${part.key}`, { size: formatBytes(part.bytes, t), count: part.count ?? 0 })}</span>)}
            <span className="block mt-1">{t("settings.storagePartsNote")}</span>
          </span> : undefined} />
        {protection && (
          <Row label={t("settings.storageDevice")} testId="settings-storage-protection"
            value={<span data-testid="settings-storage-state" data-state={protection}>{t(`settings.storageState.${protection}`)}</span>}
            hint={<span role="status">{t(`settings.storageHint.${protection}`)}</span>}
            info={protection === "protected" ? t("settings.storageInfo.protected")
              : <>{t("settings.storageInfo.unprotected")}{(isAppleMobile() || isMacSafari()) && <> {t("settings.storageInfo.safari")}</>}</>}>
            {/* Firefox answers with a prompt, so there the person asks; the others answer by themselves, asked already. */}
            {protection === "unprotected" && browserPrompts() && (
              <Button data-testid="settings-storage-protect" disabled={protecting}
                onClick={() => { setProtecting(true); void requestPersist().finally(() => setProtecting(false)); }}>{t("settings.storageProtect")}</Button>
            )}
          </Row>
        )}
        <ForkRows forks={devices?.forks} />
        <Row label={t("sidebar.deleteAllChats")} hint={confirmDeleteChats ? t("settings.deleteAllChatsConfirm", { count: chatCount }) : t("settings.deleteAllChatsHint")}>
          {confirmDeleteChats ? <>
            <Button variant="danger" data-testid="delete-all-chats-confirm" onClick={deleteChats}>{t("common.confirm")}</Button>
            <Button onClick={() => setConfirmDeleteChats(false)}>{t("common.cancel")}</Button>
          </> : (
            <Button variant="danger" data-testid="delete-all-chats" disabled={chatCount === 0} onClick={() => setConfirmDeleteChats(true)}>{t("common.delete")}</Button>
          )}
        </Row>
        <Row label={t("settings.clearAllData")} hint={t("settings.clearAllDataDescription")} info={t("settings.clearAllDataInfo")}>
          {!confirmClearData && <Button variant="danger" data-testid="clear-all-data" onClick={() => setConfirmClearData(true)}>{t("settings.clear")}</Button>}
        </Row>
        {confirmClearData && (
          // What goes, in plain lines, and what stays; why and what the network keeps is behind the row's ⓘ.
          <Block testId="clear-all-data-list">
            <div className="space-y-2 text-sm" role="group" aria-label={t("settings.clearAllData")}>
              <p className="font-semibold text-text-primary">{t("settings.clearAllDataConfirm")}</p>
              <ul className="list-disc ps-5 space-y-0.5 text-text-secondary">
                {CLEAR_ITEMS.map((item) => <li key={item} data-item={item}>{t(`settings.clearAllDataItems.${item}`)}</li>)}
              </ul>
              <p className="text-xs text-text-muted">{t("settings.clearAllDataKeeps")}</p>
              <ButtonGroup>
                <Button onClick={() => setConfirmClearData(false)}>{t("common.cancel")}</Button>
                <Button variant="danger" data-testid="clear-all-data-confirm" onClick={() => void clearData()}>{t("settings.clearAllData")}</Button>
              </ButtonGroup>
            </div>
          </Block>
        )}
      </Section>
      </SettingsGroup>

      <SettingsGroup id="about" view={view}>
      <Section title={t("settings.about")}>
        <Row label={t("settings.version")} value={<span className="font-mono">{appVersion}</span>} testId="settings-about-version" />
        <Row label={t("settings.website")} value={
          <a {...externalLinkProps(APP_WEBSITE)} className="inline-flex items-center gap-1 min-h-10 text-accent hover:text-accent-hover transition-colors">
            GitHub
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        } />
        <Row label={t("settings.license")} value={APP_LICENSE} />
      </Section>

      {update.supported && (
        <Section title={t("updates.title")}>
          <Row label={t("updates.auto")} hint={t("updates.autoDescription")}>
            <Switch label={t("updates.auto")} checked={settings.checkForUpdates} onChange={(on) => updateCheckForUpdates(on)} />
          </Row>
          <Row
            label={<span data-testid="update-status">
              {update.update
                ? t("updates.available", { version: update.update.version })
                : update.error
                  ? t("updates.failed")
                  : update.lastCheckedAt
                    ? t("updates.upToDate")
                    : `${t("settings.version")} ${appVersion}`}
            </span>}
            // Why it failed behind the ⓘ: the reason in words, then what the updater said, as it said it.
            info={!update.update && update.error ? <>
              <span className="block" data-testid="update-failure">{t(`updates.why.${updateFailure(update.error)}` as const)}</span>
              <span className="block mt-1.5 text-text-muted">{t("updates.errorDetails")}</span>
              <code className="block font-mono text-[11px] break-all" data-testid="update-error">{update.error}</code>
            </> : undefined}
            hint={update.lastCheckedAt ? t("updates.lastChecked", { when: new Date(update.lastCheckedAt).toLocaleTimeString() }) : undefined}>
            {update.update && update.update.apply === "manual" ? (
              <a {...externalLinkProps(update.downloadUrl)} className="px-4 py-2 min-h-10 inline-flex items-center rounded-lg text-sm transition-colors bg-accent hover:bg-accent-hover text-on-accent font-semibold">
                {t("updates.download")}
              </a>
            ) : update.update ? (
              <Button variant="primary" onClick={() => void update.install()} disabled={update.stage === "installing"}>
                {update.stage === "installing" ? t("updates.installing") : t(update.update.apply === "restart" ? "updates.restart" : "updates.reload")}
              </Button>
            ) : (
              <Button onClick={() => void update.check()} disabled={update.stage === "checking"}>
                {update.stage === "checking" ? t("updates.checking") : t("updates.checkNow")}
              </Button>
            )}
          </Row>
        </Section>
      )}
      </SettingsGroup>
  </>);

  // A phone: one section on a screen of its own; its header's Back goes up to the menu.
  if (isMobile && section) {
    return (
      <Page title={t(SECTION_TITLE[section])} width="md" testId={`settings-${section}-page`} overlay={overlay}>
        {groups}
      </Page>
    );
  }

  // A wider screen: every section on one page, and the index beside it once the column has room for both.
  return (
    <Page title={t("settings.title")} width="xl" testId="settings-page" overlay={overlay}>
      <div className="@3xl/page:grid @3xl/page:grid-cols-[12rem_minmax(0,42rem)] @3xl/page:justify-center @3xl/page:gap-8">
        <aside className="hidden @3xl/page:block sticky top-0 self-start">
          <SettingsIndex active={inView} shown={shown} has={has} onPick={pick} />
        </aside>
        <div ref={content} className="max-w-2xl mx-auto w-full min-w-0 space-y-6">
          {installApp}
          {groups}
        </div>
      </div>
    </Page>
  );
}
