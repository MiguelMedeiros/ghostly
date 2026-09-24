/** "3 min ago", "2 h ago", "5 d ago", or the date. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 30 * 86_400) return `${Math.floor(d / 86_400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
