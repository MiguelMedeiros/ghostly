import { useState, useEffect } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import { useUpdate } from "../contexts/UpdateContext";
import { noticeSettings, notificationPermission, openNoticeSettings, requestNotifications, type NoticePermission } from "../lib/notifications";
import { getVersion } from "@tauri-apps/api/app";
import { NetworkSettings } from "../components/NetworkSettings";
import { DomainProofSettings } from "../components/DomainProofSettings";
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
import { Select } from "../components/ui/Select";
import { CATEGORY_PREVIEW, categoryOn } from "../lib/cues";
import { playSound } from "../lib/sounds";
import {
  hashPassword,
  verifyPassword,
  getStorageUsage,
  formatBytes,
  clearAllData,
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

export function Settings() {
  const nav = useAppNavigation();
  const { settings, updateColorScheme, updateLanguage, updateLockScreen, updateNotifications, updateDefaultNickname,
    updateReduceMotion, updateChatListDensity, updateCheckForUpdates, updateLinkPreviews, randomizeNickname } =
    useSettings();
  const { t } = useI18n();
  const { lock } = useLockScreen();
  const update = useUpdate();
  const isMobile = useIsMobile();
  const profile = currentProfile();
  const myAvatar = useMyAvatar();
  const canSwitch = !!useServicesPlatform()?.features.profiles;
  const loadPublicProfiles = useLoadPublicProfiles();

  const [lockEnabled, setLockEnabled] = useState(settings.lockScreen.enabled);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    settings.lockScreen.timeoutMinutes
  );
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [storageInfo, setStorageInfo] = useState({ used: 0, keys: 0 });
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
    setRequestingNotice(false);
  };
  const [appVersion, setAppVersion] = useState("0.0.0");

  const hasPassword = !!settings.lockScreen.passwordHash;

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
      setShowPasswordForm(true);
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

  const handleSetPassword = async () => {
    if (newPassword.length < 4) {
      setMessage({ type: "error", text: t("settings.passwordTooShort") });
      return;
    }

    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: t("settings.passwordMismatch") });
      return;
    }

    if (hasPassword) {
      const valid = await verifyPassword(
        currentPassword,
        settings.lockScreen.passwordHash!
      );
      if (!valid) {
        setMessage({ type: "error", text: t("settings.incorrectPassword") });
        return;
      }
    }

    const hash = await hashPassword(newPassword);
    updateLockScreen({
      enabled: true,
      passwordHash: hash,
    });

    setLockEnabled(true);
    setNewPassword("");
    setConfirmPassword("");
    setCurrentPassword("");
    setShowPasswordForm(false);
    setMessage({
      type: "success",
      text: hasPassword
        ? t("settings.passwordChanged")
        : t("settings.passwordSet"),
    });

    setTimeout(() => setMessage(null), 3000);
  };

  const handleRemovePassword = async () => {
    if (hasPassword) {
      const valid = await verifyPassword(
        currentPassword,
        settings.lockScreen.passwordHash!
      );
      if (!valid) {
        setMessage({ type: "error", text: t("settings.incorrectPassword") });
        return;
      }
    }

    updateLockScreen({
      enabled: false,
      passwordHash: null,
    });

    setLockEnabled(false);
    setCurrentPassword("");
    setShowPasswordForm(false);
    setMessage({ type: "success", text: t("settings.passwordRemoved") });

    setTimeout(() => setMessage(null), 3000);
  };

  const field = "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent transition-colors";
  const lockOn = lockEnabled && hasPassword;
  const systemOn = settings.notifications.systemEnabled && noticePermission === "granted";
  const systemSettings = noticeSettings();
  const closePasswordForm = () => { setShowPasswordForm(false); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); };
  const deleteChats = () => {
    deleteAllSessions();
    setConfirmDeleteChats(false);
    setChatCount(0);
    setStorageInfo(getStorageUsage());
    window.dispatchEvent(new Event("session-updated"));
    setMessage({ type: "success", text: t("sidebar.deleteAllChats") });
  };
  const clearData = async () => {
    setConfirmClearData(false);
    setMessage({ type: "success", text: t("settings.dataCleared") });
    await clearAllData();
    setStorageInfo(getStorageUsage());
    // The running peer still holds what was just deleted; start it over.
    window.location.replace(window.location.pathname);
  };

  return (
    <Page title={t("settings.title")} width="md" testId="settings-page">
      {message && (
        <div role="status" className={`p-3 rounded-lg ${message.type === "success" ? "bg-accent/20 text-accent" : "bg-danger/20 text-danger"}`}>
          {message.text}
        </div>
      )}

      <Section title={t("settings.profile")}>
        {/* A phone has no account bar, and Profile no tab of its own (the bar is full): this is the way there. */}
        {isMobile && (
          <LinkRow testId="settings-profile-link" leading={<ProfileBadge entry={profile} size={36} avatar={myAvatar} />}
            label={profile.name} hint={t("settings.profileLinkHint")} onClick={() => nav.open("/profile")} />
        )}
        {/* The account switcher, where a phone's tab bar holds it (holding Settings opens it too). */}
        {isMobile && canSwitch && (
          <LinkRow testId="settings-profile-switch" label={t("profileSwitcher.title")} hint={t("profileSwitcher.holdHint")}
            value={listProfiles().length > 1 ? listProfiles().length : undefined} onClick={openProfileSwitcher} />
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
          hint={<span role="status">{noticePermission === "denied" ? (systemSettings === "macos" ? t("settings.noticesDeniedMac") : systemSettings === "windows" ? t("settings.noticesDeniedWindows") : t("settings.noticesDenied"))
            : noticePermission === "unavailable" ? t("settings.noticesUnavailable") : noticePermission === "misplaced" ? t("settings.noticesMisplaced") : t("settings.noticesRunning")}</span>}>
          {noticePermission === "denied" && systemSettings && (
            <Button data-testid="settings-notification-settings" onClick={() => void openNoticeSettings()}>{t("settings.noticesOpenSettings")}</Button>
          )}
          <Switch testId="settings-system-notifications" label={t("settings.systemNotifications")} checked={systemOn} disabled={requestingNotice} onChange={() => void toggleNotices()} />
        </Row>
      </Section>

      <Section title={t("settings.security")}>
        <Row label={t("settings.linkPreviews")} hint={t("settings.linkPreviewsHint")} info={t("settings.linkPreviewsInfo")} testId="settings-link-previews-row">
          <Switch testId="settings-link-previews" label={t("settings.linkPreviews")} checked={settings.linkPreviews} onChange={(on) => updateLinkPreviews(on)} />
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
            <Button data-testid="settings-password-edit" aria-expanded={showPasswordForm} onClick={() => (showPasswordForm ? closePasswordForm() : setShowPasswordForm(true))}>
              {showPasswordForm ? t("common.close") : t("settings.passwordEdit")}
            </Button>
          </Row>
        )}
        {showPasswordForm && (
          <Block testId="settings-password-form">
            {hasPassword && (
              <label className="block text-sm text-text-secondary">
                {t("settings.currentPassword")}
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={`${field} mt-1`} />
              </label>
            )}
            <FieldGrid>
              <label className="block text-sm text-text-secondary">
                {t("settings.newPassword")}
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={`${field} mt-1`} />
              </label>
              <label className="block text-sm text-text-secondary">
                {t("settings.confirmPassword")}
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={`${field} mt-1`} />
              </label>
            </FieldGrid>
            <ButtonGroup>
              <Button variant="primary" onClick={() => void handleSetPassword()}>
                {hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
              </Button>
              {hasPassword && <Button variant="danger" onClick={() => void handleRemovePassword()}>{t("settings.removePassword")}</Button>}
              {!hasPassword && <Button onClick={closePasswordForm}>{t("common.cancel")}</Button>}
            </ButtonGroup>
          </Block>
        )}
      </Section>

      <Section title={t("settings.data")}>
        <Row label={t("settings.storageUsed")} value={formatBytes(storageInfo.used)} />
        <Row label={t("sidebar.deleteAllChats")} hint={confirmDeleteChats ? t("settings.deleteAllChatsConfirm", { count: chatCount }) : t("settings.deleteAllChatsHint")}>
          {confirmDeleteChats ? <>
            <Button variant="danger" data-testid="delete-all-chats-confirm" onClick={deleteChats}>{t("common.confirm")}</Button>
            <Button onClick={() => setConfirmDeleteChats(false)}>{t("common.cancel")}</Button>
          </> : (
            <Button variant="danger" data-testid="delete-all-chats" disabled={chatCount === 0} onClick={() => setConfirmDeleteChats(true)}>{t("common.delete")}</Button>
          )}
        </Row>
        <Row label={t("settings.clearAllData")} hint={confirmClearData ? t("settings.clearAllDataConfirm") : t("settings.clearAllDataDescription")} info={t("settings.clearAllDataInfo")}>
          {confirmClearData ? <>
            <Button variant="danger" data-testid="clear-all-data-confirm" onClick={() => void clearData()}>{t("common.confirm")}</Button>
            <Button onClick={() => setConfirmClearData(false)}>{t("common.cancel")}</Button>
          </> : (
            <Button variant="danger" data-testid="clear-all-data" onClick={() => setConfirmClearData(true)}>{t("settings.clear")}</Button>
          )}
        </Row>
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
            hint={update.lastCheckedAt ? t("updates.lastChecked", { when: new Date(update.lastCheckedAt).toLocaleTimeString() }) : undefined}>
            {update.update && update.update.apply === "manual" ? (
              <a href={update.downloadUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 min-h-10 inline-flex items-center rounded-lg text-sm transition-colors bg-accent hover:bg-accent-hover text-on-accent font-semibold">
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

      {/* Network and identity checks: rarely changed, and the most to read, on a page of their own. */}
      <div className="bg-surface rounded-xl">
        <LinkRow testId="settings-advanced" label={t("settings.advanced")} hint={t("settings.advancedHint")} onClick={() => nav.open("/settings/advanced")} />
      </div>

      <Section title={t("settings.about")}>
        <Row label={t("settings.version")} value={<span className="font-mono">{appVersion}</span>} />
        <Row label={t("settings.website")} value={
          <a href={APP_WEBSITE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 min-h-10 text-accent hover:text-accent-hover transition-colors">
            GitHub
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        } />
        <Row label={t("settings.license")} value={APP_LICENSE} />
      </Section>
    </Page>
  );
}

/** Settings → Advanced: how this client reaches the network, and how it checks contacts' domain proofs. */
export function AdvancedSettings() {
  const { t } = useI18n();
  return (
    <Page title={t("settings.advanced")} width="md" testId="settings-advanced-page">
      <NetworkSettings />
      <DomainProofSettings />
    </Page>
  );
}
