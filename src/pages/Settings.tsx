import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import {
  hashPassword,
  verifyPassword,
  getStorageUsage,
  formatBytes,
  clearAllData,
  LANGUAGE_OPTIONS,
  COLOR_SCHEME_OPTIONS,
  COLOR_THEME_OPTIONS,
  APP_VERSION,
  APP_WEBSITE,
  APP_LICENSE,
  type ColorScheme,
  type ColorTheme,
  type Language,
} from "../lib/settings";

export function Settings() {
  const navigate = useNavigate();
  const { settings, updateColorScheme, updateColorTheme, updateLanguage, updateLockScreen, updateNotifications, updateDefaultNickname, randomizeNickname } =
    useSettings();
  const { t } = useI18n();
  const { lock } = useLockScreen();

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

  const hasPassword = !!settings.lockScreen.passwordHash;

  useEffect(() => {
    setStorageInfo(getStorageUsage());
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

  return (
    <div className="flex-1 flex flex-col bg-chat-bg overflow-hidden">
      <header className="h-14 bg-panel-header flex items-center px-4 border-b border-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 hover:bg-surface-hover rounded-full transition-colors mr-3"
        >
          <svg
            className="w-5 h-5 text-text-secondary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <h1 className="text-lg font-medium text-text-primary">
          {t("settings.title")}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-8">
          {message && (
            <div
              className={`p-3 rounded-lg ${
                message.type === "success"
                  ? "bg-accent/20 text-accent"
                  : "bg-danger/20 text-danger"
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Profile Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.profile")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-4">
              <div className="space-y-2">
                <label className="text-text-primary block font-medium">
                  {t("settings.defaultNickname")}
                </label>
                <p className="text-text-muted text-xs">
                  {t("settings.defaultNicknameHint")}
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.defaultNickname}
                    onChange={(e) => updateDefaultNickname(e.target.value)}
                    placeholder={t("settings.nicknamePlaceholder")}
                    maxLength={20}
                    className="flex-1 px-3 py-2 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
                  />
                  <button
                    onClick={randomizeNickname}
                    className="px-3 py-2 bg-surface-alt hover:bg-surface-hover border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors"
                    title={t("settings.randomizeName")}
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Appearance Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.appearance")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-6">
              {/* Color Theme */}
              <div className="space-y-3">
                <label className="text-text-primary block font-medium">
                  {t("settings.colorTheme")}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {COLOR_THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleColorThemeChange(option.value)}
                      className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                        settings.colorTheme === option.value
                          ? "border-accent bg-accent/10"
                          : "border-border hover:border-border-bright bg-surface-alt"
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          option.value === "classic"
                            ? "bg-[#00a884]"
                            : option.value === "monochrome"
                            ? "bg-gradient-to-br from-white to-gray-400"
                            : option.value === "cyan"
                            ? "bg-[#22d3ee]"
                            : "bg-[#a78bfa]"
                        }`}
                      >
                        <svg width="20" height="20" viewBox="0 0 64 64" className="text-white drop-shadow-sm">
                          <g transform="translate(12, 8)">
                            <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor"/>
                            <circle cx="13" cy="20" r="3" fill={option.value === "monochrome" ? "#666" : "#0008"}/>
                            <circle cx="27" cy="20" r="3" fill={option.value === "monochrome" ? "#666" : "#0008"}/>
                          </g>
                        </svg>
                      </div>
                      <div className="text-left">
                        <span className="text-text-primary text-sm font-medium block">
                          {t(`settings.colorThemes.${option.value}` as const)}
                        </span>
                        <span className="text-text-muted text-xs">
                          {option.description}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Color Scheme (Dark/Light) */}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <div>
                  <label className="text-text-primary block font-medium">
                    {t("settings.colorScheme")}
                  </label>
                  <p className="text-sm text-text-muted">
                    {t("settings.colorSchemeDescription")}
                  </p>
                </div>
                <div className="flex gap-1 bg-surface-alt rounded-lg p-1">
                  {COLOR_SCHEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleColorSchemeChange(option.value)}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        settings.colorScheme === option.value
                          ? "bg-accent text-white"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {option.value === "light" && (
                        <svg className="w-4 h-4 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <circle cx="12" cy="12" r="5" strokeWidth="2"/>
                          <path strokeWidth="2" strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                        </svg>
                      )}
                      {option.value === "dark" && (
                        <svg className="w-4 h-4 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
                        </svg>
                      )}
                      {option.value === "system" && (
                        <svg className="w-4 h-4 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                        </svg>
                      )}
                      {t(`settings.colorSchemes.${option.value}` as const)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Language */}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <label className="text-text-primary font-medium">
                  {t("settings.language")}
                </label>
                <select
                  value={settings.language}
                  onChange={(e) =>
                    handleLanguageChange(e.target.value as Language)
                  }
                  className="bg-surface-alt text-text-primary px-4 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.native}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {/* Security Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.security")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-4">
              {/* Lock Screen Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-text-primary block">
                    {t("settings.lockScreen")}
                  </label>
                  <p className="text-sm text-text-muted">
                    {t("settings.lockScreenDescription")}
                  </p>
                </div>
                <button
                  onClick={handleLockToggle}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    lockEnabled && hasPassword ? "bg-accent" : "bg-surface-alt"
                  }`}
                >
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      lockEnabled && hasPassword
                        ? "translate-x-6"
                        : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Timeout Selection */}
              {hasPassword && (
                <div className="flex items-center justify-between">
                  <label className="text-text-primary">
                    {t("settings.timeout")}
                  </label>
                  <select
                    value={timeoutMinutes}
                    onChange={(e) =>
                      handleTimeoutChange(Number(e.target.value))
                    }
                    className="bg-surface-alt text-text-primary px-4 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value={1}>
                      {t("settings.timeoutOptions.1")}
                    </option>
                    <option value={5}>
                      {t("settings.timeoutOptions.5")}
                    </option>
                    <option value={15}>
                      {t("settings.timeoutOptions.15")}
                    </option>
                    <option value={30}>
                      {t("settings.timeoutOptions.30")}
                    </option>
                    <option value={60}>
                      {t("settings.timeoutOptions.60")}
                    </option>
                  </select>
                </div>
              )}

              {/* Password Form */}
              {(showPasswordForm || hasPassword) && (
                <div className="border-t border-border pt-4 space-y-4">
                  {hasPassword && (
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">
                        {t("settings.currentPassword")}
                      </label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full bg-input-bg text-text-primary px-4 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      {t("settings.newPassword")}
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full bg-input-bg text-text-primary px-4 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      {t("settings.confirmPassword")}
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full bg-input-bg text-text-primary px-4 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={handleSetPassword}
                      className="flex-1 bg-accent hover:bg-accent-hover text-white py-2 px-4 rounded-lg transition-colors"
                    >
                      {hasPassword
                        ? t("settings.changePassword")
                        : t("settings.setPassword")}
                    </button>
                    {hasPassword && (
                      <button
                        onClick={handleRemovePassword}
                        className="bg-danger/10 hover:bg-danger/20 text-danger py-2 px-4 rounded-lg transition-colors"
                      >
                        {t("settings.removePassword")}
                      </button>
                    )}
                    {!hasPassword && showPasswordForm && (
                      <button
                        onClick={() => {
                          setShowPasswordForm(false);
                          setNewPassword("");
                          setConfirmPassword("");
                        }}
                        className="bg-surface-alt hover:bg-surface-hover text-text-secondary py-2 px-4 rounded-lg transition-colors"
                      >
                        {t("common.cancel")}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Lock Now Button */}
              {hasPassword && lockEnabled && (
                <div className="border-t border-border pt-4">
                  <button
                    onClick={() => {
                      lock();
                      navigate("/");
                    }}
                    className="w-full flex items-center justify-center gap-2 bg-surface-alt hover:bg-surface-hover text-text-primary py-2 px-4 rounded-lg transition-colors"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </svg>
                    {t("settings.lockNow")}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Notifications Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.notifications")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-text-primary block">
                    {t("settings.notificationSounds")}
                  </label>
                  <p className="text-sm text-text-muted">
                    {t("settings.notificationSoundsDescription")}
                  </p>
                </div>
                <button
                  onClick={() =>
                    updateNotifications({
                      soundEnabled: !settings.notifications.soundEnabled,
                    })
                  }
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    settings.notifications.soundEnabled
                      ? "bg-accent"
                      : "bg-surface-alt"
                  }`}
                >
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      settings.notifications.soundEnabled
                        ? "translate-x-6"
                        : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* Data & Storage Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.data")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-text-primary">
                  {t("settings.storageUsed")}
                </label>
                <span className="text-text-secondary">
                  {formatBytes(storageInfo.used)} ({storageInfo.keys} items)
                </span>
              </div>

              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <label className="text-text-primary block">
                      {t("settings.clearAllData")}
                    </label>
                    <p className="text-sm text-text-muted">
                      {t("settings.clearAllDataDescription")}
                    </p>
                  </div>
                </div>
                {confirmClearData ? (
                  <div className="flex items-center gap-3 animate-fade-in">
                    <span className="text-text-muted text-sm flex-1">
                      {t("settings.clearAllDataConfirm")}
                    </span>
                    <button
                      onClick={() => {
                        clearAllData();
                        setStorageInfo(getStorageUsage());
                        setConfirmClearData(false);
                        setMessage({
                          type: "success",
                          text: t("settings.dataCleared"),
                        });
                        setTimeout(() => setMessage(null), 3000);
                      }}
                      className="px-4 py-2 bg-danger/10 hover:bg-danger/20 text-danger rounded-lg text-sm font-medium transition-colors"
                    >
                      {t("common.confirm")}
                    </button>
                    <button
                      onClick={() => setConfirmClearData(false)}
                      className="px-4 py-2 bg-surface-alt hover:bg-surface-hover text-text-secondary rounded-lg text-sm font-medium transition-colors"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmClearData(true)}
                    className="w-full bg-danger/10 hover:bg-danger/20 text-danger py-2 px-4 rounded-lg transition-colors"
                  >
                    {t("settings.clearAllData")}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* About Section */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">
              {t("settings.about")}
            </h2>

            <div className="bg-surface rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between py-1">
                <span className="text-text-primary">{t("settings.version")}</span>
                <span className="text-text-secondary font-mono">{APP_VERSION}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-text-primary">{t("settings.website")}</span>
                <a
                  href={APP_WEBSITE}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-accent-hover transition-colors flex items-center gap-1"
                >
                  GitHub
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-text-primary">{t("settings.license")}</span>
                <span className="text-text-secondary">{APP_LICENSE}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
