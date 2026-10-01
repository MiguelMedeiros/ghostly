import { useI18n } from "../../contexts/I18nContext";

/**
 * The timeline's ↓ button, over its bottom end corner: "↓ 3 new" when the contact wrote while I was scrolled up, a plain ↓
 * when I am far from the bottom with nothing new. On a phone it is a round button, the count a badge on it.
 */
export function JumpToLatest({ count, far, onJump }: { count: number; far: boolean; onJump: () => void }) {
  const { t } = useI18n();
  if (!count && !far) return null;
  const label = count === 1 ? t("chat.jump.newOne") : count ? t("chat.jump.new", { count }) : t("chat.jump.bottom");
  return (
    <button type="button" data-testid="jump-latest" data-count={count} aria-label={label} title={count ? undefined : label} onClick={onJump}
      className={`absolute bottom-3 end-4 z-10 flex h-10 items-center justify-center gap-1.5 rounded-full border border-border bg-surface-alt text-text-primary shadow-lg transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent animate-fade-in max-md:w-11 max-md:h-11 ${count ? "md:ps-3 md:pe-3.5" : "w-10"}`}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
      </svg>
      {count > 0 && <span data-testid="jump-latest-label" className="text-xs font-medium max-md:hidden">{t("chat.jump.count", { count })}</span>}
      {count > 0 && (
        <span aria-hidden="true" className="absolute -top-1.5 -end-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-on-accent md:hidden">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
