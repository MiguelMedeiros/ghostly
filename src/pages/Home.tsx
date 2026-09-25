import { createPairedChat } from "../lib/pairedChat";
import { useState } from "react";
import { JoinDialog } from "../components/JoinDialog";
import { useI18n } from "../contexts/I18nContext";
import { ensureSession } from "../lib/storage";
import { HomeProjectLinks } from "../components/HomeProjectLinks";
import { chatPath } from "../lib/url";
import { groupPath } from "../lib/groups";
import { engine } from "@ghostly/browser/platform/engine";
import { useAppNavigation } from "../hooks/useAppNavigation";

export function Home() {
  const nav = useAppNavigation();
  const { t } = useI18n();
  const [isCreating, setIsCreating] = useState(false);

  const [joining, setJoining] = useState(false);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      nav.conversation(chatPath(await createPairedChat()));
    } finally { setIsCreating(false); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-chat-bg">
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="text-center flex flex-col gap-5 animate-fade-in w-full max-w-[388px] px-6 py-6">
        <div className="flex flex-col items-center gap-2">
        <div className="text-accent">
          <svg className="w-16 h-16 mx-auto" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
            <circle cx="9" cy="9" r="1.5" fill="#111b21"/>
            <circle cx="15" cy="9" r="1.5" fill="#111b21"/>
          </svg>
        </div>
        <h2 className="text-text-primary text-2xl font-light">
          {t("app.name")}
        </h2>
        <p className="text-text-muted text-sm leading-tight">
          {t("home.description")}
        </p>
        </div>
          <ul className="mx-auto flex w-fit max-w-full flex-col gap-2 text-left text-text-muted text-xs leading-relaxed">
            <li className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-accent">
                <rect x="5" y="10" width="14" height="11" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
              </svg>
              <span>{t("home.features.encrypted")}</span>
            </li>
            <li className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-accent">
                <circle cx="12" cy="14" r="8" />
                <path d="M12 10v4l2 2M9 2h6M12 2v4M18 6l2-2" />
              </svg>
              <span>{t("home.features.ephemeral")}</span>
            </li>
            <li className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-accent">
                <circle cx="12" cy="5" r="3" /><circle cx="5" cy="18" r="3" /><circle cx="19" cy="18" r="3" />
                <path d="m10.5 7.6-4 7.8m7-7.8 4 7.8M8 18h8" />
              </svg>
              <span>{t("home.features.decentralized")}</span>
            </li>
          </ul>
        <div className="grid grid-cols-2 items-stretch gap-3" data-testid="home-chat-actions">
        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-chat-bg disabled:opacity-50"
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
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                <path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/>
              </svg>
              {t("sidebar.newChat")}
            </>
          )}
        </button>
        <button onClick={() => setJoining(true)} className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><svg aria-hidden="true" width="18" height="18" className="shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5 M3 12h12 M10 7l5 5-5 5"/></svg>Join</button>
        </div>
        {joining && <JoinDialog onClose={() => setJoining(false)} onJoin={keys => {setJoining(false);nav.conversation(chatPath(ensureSession(keys)));}}
          onOpenChat={id => { setJoining(false); nav.conversation(chatPath(id)); }}
          onJoinGroup={async link => { const { groupId } = await engine.call("joinGroupByLink", { link }); setJoining(false); nav.conversation(groupPath(groupId)); }} />}
      </div>
    </div>
    <HomeProjectLinks />
    </div>
  );
}
