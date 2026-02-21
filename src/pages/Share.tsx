import { useLocation, useNavigate, Navigate } from "react-router-dom";
import { QRCodeDisplay } from "../components/QRCode";
import { useState } from "react";

interface ShareState {
  creatorUrl: string;
  inviteUrl: string;
}

export function Share() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as ShareState | null;
  const [showCreatorUrl, setShowCreatorUrl] = useState(false);

  if (!state) {
    return <Navigate to="/" replace />;
  }

  const handleEnterChat = () => {
    try {
      const url = new URL(state.creatorUrl);
      const chatPath = url.hash.replace(/^#/, "");
      navigate(chatPath);
    } catch {
      navigate("/");
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-8 animate-fade-in">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-text-primary mb-2">
            Drop Created
          </h2>
          <p className="text-text-secondary text-sm">
            Share the invite link below with your contact
          </p>
        </div>

        <div className="border border-border rounded-lg p-6 bg-surface-alt/50">
          <QRCodeDisplay value={state.inviteUrl} label="Invite Link" />
        </div>

        <div className="border border-border rounded-lg p-4 bg-surface-alt/50">
          <button
            onClick={() => setShowCreatorUrl(!showCreatorUrl)}
            className="w-full flex items-center justify-between text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer bg-transparent border-none font-mono"
          >
            <span className="uppercase tracking-wider font-bold">
              Your link (creator)
            </span>
            <span>{showCreatorUrl ? "▲" : "▼"}</span>
          </button>
          {showCreatorUrl && (
            <div className="mt-3 space-y-2 animate-fade-in">
              <input
                type="text"
                readOnly
                value={state.creatorUrl}
                className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-muted truncate font-mono"
              />
              <p className="text-danger text-[10px] leading-relaxed">
                Save this link — it contains your private key and cannot be
                recovered. Bookmark it or store it somewhere safe.
              </p>
            </div>
          )}
        </div>

        <button
          onClick={handleEnterChat}
          className="w-full py-3.5 bg-accent-dim hover:bg-accent/30 text-text-primary rounded-lg font-bold text-sm tracking-wider uppercase transition-colors cursor-pointer border border-accent/20"
        >
          Enter Chat
        </button>
      </div>
    </div>
  );
}
