export function PinIcon({ active = false }: { active?: boolean }) {
  return <svg className="conversation-pin overflow-visible" style={{ transform: active ? "rotate(-45deg)" : "rotate(0deg)" }} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path fill={active ? "currentColor" : "none"} d="m16 3 5 5-3 1-4 4v4l-2 2-7-7 2-2h4l4-4Z"/><path d="M9 15l-6 6"/></svg>;
}
