const GHOST_NAMES = [
  "Casper", "Phantom", "Specter", "Shadow", "Wraith", "Spirit", "Poltergeist", "Banshee", "Shade", "Apparition",
  "Ghoul", "Spook", "Haunt", "Eidolon", "Revenant", "Wisp", "Vapor", "Mist", "Echo", "Whisper",
];

/** Stable nickname for a peer that has not told us its own. */
export function ghostName(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return GHOST_NAMES[Math.abs(hash) % GHOST_NAMES.length];
}

export function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function Dot({ on }: { on: boolean }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-live" : "bg-edge"}`} />;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      className="rounded border border-edge px-2 py-1 text-xs text-mist hover:text-white"
      onClick={(e) => {
        const button = e.currentTarget;
        void navigator.clipboard.writeText(text).then(() => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = label), 1200);
        });
      }}
    >
      {label}
    </button>
  );
}
