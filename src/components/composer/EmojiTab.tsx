import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { emojiCategories, emojiOf, recentEmoji, rememberEmoji, searchEmoji, setSkinTone, skinTone, withSkin } from "../../lib/emoji";
import { EMOJI_CATEGORY_ICONS } from "./icons";
import { CategoryBar, PanelSearch } from "./PanelParts";

interface Cell { native: string; name: string }
interface Section { id: string; title: string; cells: Cell[] }

/** The grid scrolled so a category's heading is at its top. */
function scrollToSection(box: HTMLElement | null, id: string) {
  const section = box?.querySelector<HTMLElement>(`[data-section="${id}"]`);
  if (box && section) box.scrollTop = section.offsetTop;
}

const TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/**
 * The panel's emoji: category icons over a search field, then this profile's recent emoji and every category
 * in one scrolling grid. The icons jump to their category and follow the scroll. The recent row is the one the
 * panel opened with, so the grid does not move under a pointer while picking several.
 */
export function EmojiTab({ onPick, autoFocus }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [skin, setSkin] = useState(skinTone);
  const [choosingSkin, setChoosingSkin] = useState(false);
  const [recent] = useState(recentEmoji);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const jumpTo = useRef<string | null>(null);

  const sections = useMemo<Section[]>(() => [
    ...(recent.length ? [{ id: "recent", title: t("composer.category.recent"), cells: recent.map((native) => ({ native, name: emojiOf(native)?.name ?? native })) }] : []),
    ...emojiCategories().map((c) => ({ id: c.id, title: t(`composer.category.${c.id}` as Parameters<typeof t>[0]), cells: c.emojis.map((e) => ({ native: withSkin(e, skin), name: e.name })) })),
  ], [recent, skin, t]);
  const results = useMemo<Section | null>(() => query.trim()
    ? { id: "search", title: t("composer.searchResults"), cells: searchEmoji(query).map((e) => ({ native: withSkin(e, skin), name: e.name })) }
    : null, [query, skin, t]);
  const [active, setActive] = useState(sections[0]?.id ?? null);

  useEffect(() => { if (autoFocus) search.current?.focus({ preventScroll: true }); }, [autoFocus]);

  // A category chosen while searching is scrolled to once the search is gone and the grid is back.
  useEffect(() => {
    if (!jumpTo.current || results) return;
    scrollToSection(scroller.current, jumpTo.current);
    jumpTo.current = null;
  }, [results]);

  const choose = (id: string) => {
    setActive(id);
    if (query) { jumpTo.current = id; setQuery(""); }
    else scrollToSection(scroller.current, id);
  };

  const followScroll = () => {
    const box = scroller.current;
    if (!box || results) return;
    let current = sections[0]?.id ?? null;
    for (const el of box.querySelectorAll<HTMLElement>("[data-section]")) if (el.offsetTop <= box.scrollTop + 8) current = el.dataset.section!;
    setActive(current);
  };

  const pick = (native: string) => { rememberEmoji(native); onPick(native); };
  const click = (e: MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-emoji]");
    if (cell) pick(cell.dataset.emoji!);
  };

  const cells = () => [...(scroller.current?.querySelectorAll<HTMLElement>("[data-emoji]") ?? [])];
  // One tab stop for the whole grid; the arrows move within it.
  const rove = (to: HTMLElement) => {
    for (const cell of cells()) if (cell.tabIndex === 0 && cell !== to) cell.tabIndex = -1;
    to.tabIndex = 0;
    to.focus();
  };
  const keys = (e: KeyboardEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-emoji]");
    if (!cell || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const all = cells(), at = all.indexOf(cell);
    const grid = cell.parentElement!;
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter((c) => /px$/.test(c)).length || 8);
    const rtl = getComputedStyle(grid).direction === "rtl";
    const step = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ArrowUp: -columns, ArrowDown: columns, Home: -at, End: all.length - 1 - at }[e.key]!;
    if (e.key === "ArrowUp" && at < columns) { search.current?.focus(); return; }
    rove(all[Math.min(all.length - 1, Math.max(0, at + step))]);
  };
  const searchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    const first = cells()[0];
    if (e.key === "Enter" && results?.cells[0]) { e.preventDefault(); pick(results.cells[0].native); }
    else if (e.key === "ArrowDown" && first) { e.preventDefault(); rove(first); }
  };

  const shown = results ? [results] : sections;
  return (
    <div className="expression-tab" data-testid="emoji-tab">
      <CategoryBar label={t("composer.emojiCategories")} testIdPrefix="emoji-category" active={results ? null : active} onChoose={choose}
        items={sections.map((s) => ({ id: s.id, label: s.title, icon: EMOJI_CATEGORY_ICONS[s.id] }))} />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("composer.searchEmoji")} inputRef={search} onKeyDown={searchKeys}
        after={<div className="relative">
          <button type="button" data-testid="emoji-skin" aria-label={t("composer.skinTone")} title={t("composer.skinTone")} aria-expanded={choosingSkin}
            onClick={() => setChoosingSkin((v) => !v)} className="expression-skin">{TONES[skin]}</button>
          {choosingSkin && <div role="radiogroup" aria-label={t("composer.skinTone")} className="expression-skins" data-testid="emoji-skins">
            {TONES.map((tone, i) => <button key={tone} type="button" role="radio" aria-checked={i === skin} aria-label={tone} data-testid={`emoji-skin-${i}`}
              onClick={() => { setSkin(i); setSkinTone(i); setChoosingSkin(false); }}>{tone}</button>)}
          </div>}
        </div>} />
      <div ref={scroller} className="expression-scroll" data-testid="emoji-grid" onScroll={followScroll} onClick={click} onKeyDown={keys}
        onFocus={(e) => { const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-emoji]"); if (cell && cell.tabIndex !== 0) rove(cell); }}>
        {shown.map((section, i) => <EmojiSection key={section.id} section={section} first={i === 0} />)}
        {results && !results.cells.length && <p className="expression-empty">{t("composer.noEmoji")}</p>}
      </div>
    </div>
  );
}

/** One category's heading and grid; unchanged sections are not drawn again while picking. */
const EmojiSection = memo(function EmojiSection({ section, first }: { section: Section; first: boolean }) {
  return (
    <section data-section={section.id} data-testid={`emoji-section-${section.id}`} aria-label={section.title}>
      <h3 className="expression-section-title">{section.title}</h3>
      <div className="emoji-grid">
        {section.cells.map((cell, i) => (
          <button key={cell.native} type="button" className="emoji-cell" data-emoji={cell.native} aria-label={cell.native} title={cell.name}
            tabIndex={first && i === 0 ? 0 : -1}>{cell.native}</button>
        ))}
      </div>
    </section>
  );
});
