import { useState, useEffect, useRef } from "react";
import { useLockScreen } from "../contexts/LockScreenContext";
import { useI18n } from "../contexts/I18nContext";

export function LockScreen() {
  const { isLocked, unlock } = useLockScreen();
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isLocked && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked) {
      setPassword("");
      setError(false);
    }
  }, [isLocked]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isUnlocking) return;

    setIsUnlocking(true);
    setError(false);

    const success = await unlock(password);

    if (!success) {
      setError(true);
      setPassword("");
      inputRef.current?.focus();
    }

    setIsUnlocking(false);
  };

  if (!isLocked) return null;

  return (
    <div className="fixed inset-0 z-50 bg-app-bg flex items-center justify-center">
      <div className="w-full max-w-sm mx-4">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-surface flex items-center justify-center">
            <svg
              className="w-10 h-10 text-accent"
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
          </div>
          <h1 className="text-2xl font-semibold text-text-primary mb-2">
            {t("lockScreen.title")}
          </h1>
          <p className="text-text-secondary">{t("lockScreen.enterPassword")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
              placeholder={t("settings.password")}
              className={`w-full bg-surface text-text-primary px-4 py-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-accent transition-all ${
                error
                  ? "border-danger animate-shake"
                  : "border-border"
              }`}
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p className="text-danger text-sm text-center animate-fade-in">
              {t("lockScreen.incorrectPassword")}
            </p>
          )}

          <button
            type="submit"
            disabled={!password || isUnlocking}
            className="w-full bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 px-4 rounded-xl font-medium transition-colors"
          >
            {isUnlocking ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="animate-spin h-5 w-5"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              </span>
            ) : (
              t("lockScreen.unlock")
            )}
          </button>
        </form>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
}
