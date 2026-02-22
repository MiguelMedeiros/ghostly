import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePkarr } from "../hooks/usePkarr";
import { generateSessionId, saveInviteCode } from "../lib/storage";

export function Home() {
  const navigate = useNavigate();
  const { createDrop } = usePkarr();
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
        <div className="text-accent text-6xl mb-2">&#9670;</div>
        <h2 className="text-text-primary text-2xl font-light">
          Dead Drop
        </h2>
        <p className="text-text-muted text-sm leading-relaxed">
          Ephemeral encrypted messaging over the DHT.
          <br />
          No server. No accounts. No trace.
        </p>
        <div className="border-t border-border pt-4 mt-6">
          <p className="text-text-muted text-xs leading-relaxed">
            Messages are encrypted and published as DNS records to the Mainline
            DHT via Pkarr. Your private keys never leave this device. Messages
            expire when you stop republishing.
          </p>
        </div>
        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-[#111b21] rounded-lg font-bold text-sm tracking-wider uppercase hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCreating ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              Creating...
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create New Chat
            </>
          )}
        </button>
        <p className="text-text-muted text-xs">
          Or join with an invite link from the sidebar.
        </p>
      </div>
    </div>
  );
}
