import { Link, useLocation } from "react-router-dom";

interface HeaderProps {
  onBurn?: () => void;
  showBurn?: boolean;
  confirmBurn?: boolean;
  onCancelBurn?: () => void;
}

export function Header({ onBurn, showBurn, confirmBurn, onCancelBurn }: HeaderProps) {
  const location = useLocation();
  const isChat = location.pathname.startsWith("/chat");

  return (
    <header className="border-b border-border px-4 py-3 flex items-center justify-between bg-surface-alt/80 backdrop-blur-sm">
      <Link to="/" className="flex items-center gap-2 no-underline">
        <span className="text-accent text-xl font-bold tracking-tight">
          DEAD DROP
        </span>
        <span className="text-text-muted text-xs hidden sm:inline">
          ephemeral · encrypted · serverless
        </span>
      </Link>
      <div className="flex items-center gap-3">
        {showBurn && isChat && (
          confirmBurn ? (
            <div className="flex items-center gap-2">
              <span className="text-danger text-[10px]">Are you sure?</span>
              <button
                onClick={onBurn}
                className="px-3 py-1.5 bg-danger/30 text-danger border border-danger/50 rounded text-xs font-bold uppercase tracking-wider hover:bg-danger/40 transition-colors cursor-pointer"
              >
                Yes, Burn
              </button>
              <button
                onClick={onCancelBurn}
                className="px-3 py-1.5 bg-surface-hover text-text-muted border border-border rounded text-xs font-bold uppercase tracking-wider hover:text-text-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={onBurn}
              className="px-3 py-1.5 bg-danger/20 text-danger border border-danger/30 rounded text-xs font-bold uppercase tracking-wider hover:bg-danger/30 transition-colors cursor-pointer"
            >
              Burn
            </button>
          )
        )}
      </div>
    </header>
  );
}
