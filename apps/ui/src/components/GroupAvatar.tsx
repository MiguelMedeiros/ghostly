/**
 * A group's picture (WISP 9xx § Metadata), or the group glyph when it has none. The picture is the
 * data URL the engine kept after checking it (`sanitizeAvatar`): it is drawn, never fetched.
 */
export function GroupAvatar({ picture, size, glyph = Math.round(size * 0.46), className = "", testId }: { picture?: string; size: number; glyph?: number; className?: string; testId?: string }) {
  return (
    <div data-testid={testId} data-picture={picture ? "set" : "none"} style={{ width: size, height: size }}
      className={`relative rounded-full flex items-center justify-center shrink-0 overflow-hidden text-accent ${className}`}>
      {picture
        ? <img src={picture} alt="" draggable={false} className="w-full h-full object-cover" />
        : <GroupGlyph size={glyph} />}
    </div>
  );
}

export function GroupGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
