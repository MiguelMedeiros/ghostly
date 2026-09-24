import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import { useUpdate } from "../contexts/UpdateContext";
import { notificationPermission, requestNotifications, type NoticePermission } from "../lib/notifications";
import { getVersion } from "@tauri-apps/api/app";
import { NetworkSettings } from "../components/NetworkSettings";
import { DomainProofSettings } from "../components/DomainProofSettings";
import { Block, ButtonGroup, FieldGrid, InputGroup, LinkRow, Page, Row, Section } from "../components/layout";
import { ProfileBadge } from "../components/ProfileBadge";
import { useIsMobile } from "../hooks/useIsMobile";
import { useMyAvatar } from "../hooks/useAvatars";
import { currentProfile, listProfiles } from "../lib/profiles";
import { openProfileSwitcher } from "../hooks/useProfileSwitcher";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { Switch } from "../components/wallet/ui";
import {
  hashPassword,
  verifyPassword,
  getStorageUsage,
  formatBytes,
  clearAllData,
  LANGUAGE_OPTIONS,
  COLOR_SCHEME_OPTIONS,
  COLOR_THEME_OPTIONS,
  APP_WEBSITE,
  APP_LICENSE,
  type ColorScheme,
  type ColorTheme,
  type Language,
} from "../lib/settings";
import { deleteAllSessions, listSessions } from "../lib/storage";

export function Settings() {
  const navigate = useNavigate();
  const { settings, updateColorScheme, updateColorTheme, updateLanguage, updateLockScreen, updateNotifications, updateDefaultNickname,
    updateReduceMotion, updateCheckForUpdates, randomizeNickname } =
    useSettings();
  const { t } = useI18n();
  const { lock } = useLockScreen();
  const update = useUpdate();
  const isMobile = useIsMobile();
  const profile = currentProfile();
  const myAvatar = useMyAvatar();
  const canSwitch = !!useServicesPlatform()?.features.profiles;

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

  const handleColorThemeChange = (theme: ColorTheme) => {
    updateColorTheme(theme);
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
  const select = "min-h-10 max-w-full bg-surface-alt text-text-primary px-3 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent";
  const button = "px-4 py-2 min-h-10 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const lockOn = lockEnabled && hasPassword;
  const systemOn = settings.notifications.systemEnabled && noticePermission === "granted";

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
            label={profile.name} hint={t("settings.profileLinkHint")} onClick={() => navigate("/profile")} />
        )}
        {/* The account switcher, where a phone's tab bar holds it (holding Settings opens it too). */}
        {isMobile && canSwitch && (
          <LinkRow testId="settings-profile-switch" label={t("profileSwitcher.title")} hint={t("profileSwitcher.holdHint")}
            value={listProfiles().length > 1 ? listProfiles().length : undefined} onClick={openProfileSwitcher} />
        )}
        <Block>
          <div>
            <label htmlFor="settings-nickname" className="text-text-primary text-sm block">{t("settings.defaultNickname")}</label>
            <p className="text-text-muted text-xs mt-0.5">{t("settings.defaultNicknameHint")}</p>
          </div>
          <InputGroup>
            <input id="settings-nickname" type="text" value={settings.defaultNickname} onChange={(e) => updateDefaultNickname(e.target.value)}
              placeholder={t("settings.nicknamePlaceholder")} maxLength={20} className={field} />
            <button onClick={randomizeNickname} title={t("settings.randomizeName")} aria-label={t("settings.randomizeName")}
              className="grid place-items-center w-10 h-10 bg-surface-alt hover:bg-surface-hover border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </InputGroup>
        </Block>
      </Section>

      <Section title={t("settings.appearance")}>
        <Block>
          <p className="text-text-primary text-sm">{t("settings.colorTheme")}</p>
          <FieldGrid min="10.5rem">
            {COLOR_THEME_OPTIONS.map((option) => (
              <button key={option.value} onClick={() => handleColorThemeChange(option.value)}
                className={`flex items-center gap-3 min-w-0 p-3 rounded-xl border-2 transition-all cursor-pointer ${settings.colorTheme === option.value ? "border-accent bg-accent/10" : "border-border hover:border-border-bright bg-surface-alt"}`}>
                <div className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${option.value === "classic" ? "bg-[#00a884]" : option.value === "monochrome" ? "bg-gradient-to-br from-white to-gray-400" : option.value === "cyan" ? "bg-[#22d3ee]" : "bg-[#a78bfa]"}`}>
                  <svg width="20" height="20" viewBox="0 0 64 64" className="text-white drop-shadow-sm" aria-hidden="true">
                    <g transform="translate(12, 8)">
                      <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" />
                      <circle cx="13" cy="20" r="3" fill={option.value === "monochrome" ? "#666" : "#0008"} />
                      <circle cx="27" cy="20" r="3" fill={option.value === "monochrome" ? "#666" : "#0008"} />
                    </g>
                  </svg>
                </div>
                <div className="text-left min-w-0">
                  <span className="text-text-primary text-sm font-medium block truncate">{t(`settings.colorThemes.${option.value}` as const)}</span>
                  <span className="text-text-muted text-xs block truncate">{option.description}</span>
                </div>
              </button>
            ))}
          </FieldGrid>
        </Block>
        <Row label={t("settings.colorScheme")} hint={t("settings.colorSchemeDescription")}>
          <div className="flex flex-wrap gap-1 bg-surface-alt rounded-lg p-1">
            {COLOR_SCHEME_OPTIONS.map((option) => (
              <button key={option.value} onClick={() => handleColorSchemeChange(option.value)} aria-pressed={settings.colorScheme === option.value}
                className={`flex items-center gap-1 px-3 min-h-8 rounded-md text-sm whitespace-nowrap transition-colors cursor-pointer ${settings.colorScheme === option.value ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"}`}>
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
        <Row label={t("settings.language")}>
          <select aria-label={t("settings.language")} value={settings.language} onChange={(e) => handleLanguageChange(e.target.value as Language)} className={select}>
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.native}</option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title={t("settings.security")}>
        <Row label={t("settings.lockScreen")} hint={t("settings.lockScreenDescription")}>
          <Switch label={t("settings.lockScreen")} checked={lockOn} onChange={() => void handleLockToggle()} />
        </Row>
        {hasPassword && (
          <Row label={t("settings.timeout")}>
            <select aria-label={t("settings.timeout")} value={timeoutMinutes} onChange={(e) => handleTimeoutChange(Number(e.target.value))} className={select}>
              <option value={1}>{t("settings.timeoutOptions.1")}</option>
              <option value={5}>{t("settings.timeoutOptions.5")}</option>
              <option value={15}>{t("settings.timeoutOptions.15")}</option>
              <option value={30}>{t("settings.timeoutOptions.30")}</option>
              <option value={60}>{t("settings.timeoutOptions.60")}</option>
            </select>
          </Row>
        )}
        {(showPasswordForm || hasPassword) && (
          <Block>
            {hasPassword && (
              <label className="block text-sm text-text-secondary">
                {t("settings.currentPassword")}
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={`${field} mt-1`} />
              </label>
            )}
            <label className="block text-sm text-text-secondary">
              {t("settings.newPassword")}
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={`${field} mt-1`} />
            </label>
            <label className="block text-sm text-text-secondary">
              {t("settings.confirmPassword")}
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={`${field} mt-1`} />
            </label>
            <ButtonGroup fill>
              <button onClick={handleSetPassword} className={`${button} bg-accent hover:bg-accent-hover text-white`}>
                {hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
              </button>
              {hasPassword && (
                <button onClick={handleRemovePassword} className={`${button} bg-danger/10 hover:bg-danger/20 text-danger`}>
                  {t("settings.removePassword")}
                </button>
              )}
              {!hasPassword && showPasswordForm && (
                <button onClick={() => { setShowPasswordForm(false); setNewPassword(""); setConfirmPassword(""); }} className={`${button} bg-surface-alt hover:bg-surface-hover text-text-secondary`}>
                  {t("common.cancel")}
                </button>
              )}
            </ButtonGroup>
          </Block>
        )}
        {hasPassword && lockEnabled && (
          <Block>
            <button onClick={() => { lock(); navigate("/"); }} className={`${button} w-full flex items-center justify-center gap-2 bg-surface-alt hover:bg-surface-hover text-text-primary`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              {t("settings.lockNow")}
            </button>
          </Block>
        )}
      </Section>

      <Section title={t("settings.notifications")}>
        <Row label={t("settings.notificationSounds")} hint={t("settings.notificationSoundsDescription")}>
          <Switch label={t("settings.notificationSounds")} checked={settings.notifications.soundEnabled} onChange={(on) => updateNotifications({ soundEnabled: on })} />
        </Row>
        <Row label={t("settings.systemNotifications")}
          hint={<span role="status">{noticePermission === "denied" ? t("settings.noticesDenied") : noticePermission === "unavailable" ? t("settings.noticesUnavailable") : t("settings.noticesRunning")}</span>}>
          <Switch label={t("settings.systemNotifications")} checked={systemOn} disabled={requestingNotice} onChange={() => void toggleNotices()} />
        </Row>
        <Row label="Reduce motion" hint="Turn off animations for messages, payments and calls. Your system's setting is respected either way.">
          <Switch label="Reduce motion" checked={settings.reduceMotion} onChange={(on) => updateReduceMotion(on)} />
        </Row>
      </Section>

      <NetworkSettings />

      <DomainProofSettings />

      <Section title={t("settings.data")}>
        <Row label={t("settings.storageUsed")} value={`${formatBytes(storageInfo.used)} (${storageInfo.keys} items)`} />
        <Block>
          <div>
            <p className="text-text-primary text-sm">{t("sidebar.deleteAllChats")}</p>
            <p className="text-xs text-text-muted mt-0.5">
              Every conversation on this device goes, along with its messages and files. Your settings and your wallet stay.
            </p>
          </div>
          {confirmDeleteChats ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 animate-fade-in">
              <span className="text-text-muted text-sm flex-[1_1_10rem]">Delete all {chatCount} chats?</span>
              <ButtonGroup>
                <button data-testid="delete-all-chats-confirm"
                  onClick={() => {
                    deleteAllSessions();
                    setConfirmDeleteChats(false);
                    setChatCount(0);
                    setStorageInfo(getStorageUsage());
                    window.dispatchEvent(new Event("session-updated"));
                    setMessage({ type: "success", text: t("sidebar.deleteAllChats") });
                  }}
                  className={`${button} bg-danger/10 hover:bg-danger/20 text-danger`}>
                  {t("common.confirm")}
                </button>
                <button onClick={() => setConfirmDeleteChats(false)} className={`${button} bg-surface-alt hover:bg-surface-hover text-text-secondary`}>
                  {t("common.cancel")}
                </button>
              </ButtonGroup>
            </div>
          ) : (
            <button data-testid="delete-all-chats" disabled={chatCount === 0} onClick={() => setConfirmDeleteChats(true)} className={`${button} w-full bg-danger/10 hover:bg-danger/20 text-danger`}>
              {t("sidebar.deleteAllChats")}
            </button>
          )}
        </Block>
        <Block>
          <div>
            <p className="text-text-primary text-sm">{t("settings.clearAllData")}</p>
            <p className="text-xs text-text-muted mt-0.5">{t("settings.clearAllDataDescription")}</p>
          </div>
          {confirmClearData ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 animate-fade-in">
              <span className="text-text-muted text-sm flex-[1_1_10rem]">{t("settings.clearAllDataConfirm")}</span>
              <ButtonGroup>
                <button
                  onClick={async () => {
                    setConfirmClearData(false);
                    setMessage({ type: "success", text: t("settings.dataCleared") });
                    await clearAllData();
                    setStorageInfo(getStorageUsage());
                    // The running peer still holds what was just deleted; start it over.
                    window.location.replace(window.location.pathname);
                  }}
                  className={`${button} bg-danger/10 hover:bg-danger/20 text-danger`}>
                  {t("common.confirm")}
                </button>
                <button onClick={() => setConfirmClearData(false)} className={`${button} bg-surface-alt hover:bg-surface-hover text-text-secondary`}>
                  {t("common.cancel")}
                </button>
              </ButtonGroup>
            </div>
          ) : (
            <button onClick={() => setConfirmClearData(true)} className={`${button} w-full bg-danger/10 hover:bg-danger/20 text-danger`}>
              {t("settings.clearAllData")}
            </button>
          )}
        </Block>
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
              <a href={update.downloadUrl} target="_blank" rel="noopener noreferrer" className={`${button} inline-flex items-center bg-accent hover:bg-accent-hover text-[#111b21] font-semibold`}>
                {t("updates.download")}
              </a>
            ) : update.update ? (
              <button onClick={() => void update.install()} disabled={update.stage === "installing"} className={`${button} bg-accent hover:bg-accent-hover text-[#111b21] font-semibold`}>
                {update.stage === "installing" ? t("updates.installing") : t(update.update.apply === "restart" ? "updates.restart" : "updates.reload")}
              </button>
            ) : (
              <button onClick={() => void update.check()} disabled={update.stage === "checking"} className={`${button} bg-surface-alt hover:bg-surface-hover text-text-primary`}>
                {update.stage === "checking" ? t("updates.checking") : t("updates.checkNow")}
              </button>
            )}
          </Row>
        </Section>
      )}

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
