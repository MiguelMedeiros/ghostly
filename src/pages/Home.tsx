import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePkarr } from "../hooks/usePkarr";
import { useI18n } from "../contexts/I18nContext";
import { generateSessionId, saveInviteCode } from "../lib/storage";

export function Home() {
  const navigate = useNavigate();
  const { createDrop } = usePkarr();
  const { t } = useI18n();
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const drop = await createDrop();
      const sessionId = generateSessionId(drop.seedA, drop.pubKeyB);
      saveInviteCode(sessionId, drop.inviteCode);
      navigate(`/chat/${drop.seedA}/${drop.pubKeyB}/${drop.encKey}`);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-chat-bg">
      <div className="text-center space-y-4 animate-fade-in max-w-md px-6">
        <div className="text-accent mb-2">
          <svg className="w-16 h-16 mx-auto" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
            <circle cx="9" cy="9" r="1.5" fill="#111b21"/>
            <circle cx="15" cy="9" r="1.5" fill="#111b21"/>
          </svg>
        </div>
        <h2 className="text-text-primary text-2xl font-light">
          {t("app.name")}
        </h2>
        <p className="text-text-muted text-sm leading-relaxed">
          {t("app.tagline")}
        </p>
        <div className="border-t border-border pt-4 mt-6">
          <p className="text-text-muted text-xs leading-relaxed">
            {t("home.features.encrypted")} · {t("home.features.ephemeral")} · {t("home.features.decentralized")}
          </p>
        </div>
        <p className="text-text-muted text-xs">
          {t("home.description")}
        </p>
        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-[#111b21] rounded-lg font-bold text-sm tracking-wider uppercase hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mt-4"
        >
          {isCreating ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              {t("common.loading")}
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t("home.createChat")}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
