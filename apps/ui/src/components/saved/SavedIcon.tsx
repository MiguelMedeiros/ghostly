/** The saved mark (a bookmark): the Saved view's, its entry above the chat list, and a message's Save in its ⋮ menu. */
export function SavedIcon({ size = 16, filled = false, strokeWidth = 2, className }: { size?: number; filled?: boolean; strokeWidth?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 3.5h12v17l-6-4.2-6 4.2z" />
    </svg>
  );
}
