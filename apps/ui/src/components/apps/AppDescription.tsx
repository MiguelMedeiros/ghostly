import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";

/** At most one blank line in a row, none at either end, whatever line break the text uses. */
function foldBlankLines(text: string): string {
  const lines = text.replace(/\r\n?|[\v\f\x85\p{Zl}\p{Zp}]/gu, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const blank = !line.trim();
    if (blank && (kept.length === 0 || !kept[kept.length - 1]!.trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n");
}

/**
 * A publisher's or a store's own description (2000 characters, which may hold line breaks): its blank lines folded,
 * under a caption that says whose words they are, a few lines high until Show all. Each screen draws it after
 * Ghostly's own lines (the permissions, Removed or Revoked, an expired list): drawn before them, as it came, 1900 blank
 * lines pushed them 38,000 px down, under a first line that could read as Ghostly's own ("✓ Verified by Ghostly").
 */
export function AppDescription({ text, from, testId }: { text: string; from: "publisher" | "store"; testId: string }) {
  const { t } = useI18n();
  const shown = foldBlankLines(text);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  // Whether the clamp hides anything, read again when the screen's width changes (a phone turned).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [shown, open]);
  if (!shown) return null;
  return (
    <div className="ps-3 border-s-2 border-border space-y-1" data-testid={testId}>
      <p className="text-xs text-text-muted">{t(from === "publisher" ? "apps.install.fromPublisher" : "apps.store.fromStore")}</p>
      <p ref={ref} id={id} dir="auto" className={`text-sm text-text-secondary whitespace-pre-line [overflow-wrap:anywhere] ${open ? "" : "line-clamp-4"}`}>{shown}</p>
      {/* On a phone a 44 px target, as every control there: its line of small print was 16 px tall. */}
      {(clipped || open) && (
        <button type="button" data-testid={`${testId}-more`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
          className="text-xs text-accent hover:underline max-md:min-h-11 max-md:min-w-11">
          {t(open ? "apps.install.descriptionLess" : "apps.install.descriptionMore")}
        </button>
      )}
    </div>
  );
}
