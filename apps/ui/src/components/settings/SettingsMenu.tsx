import { useState, type ReactNode } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { LinkRow } from "../layout";
import { SECTION_TITLE, SETTINGS_SECTIONS, searchSettings, type SettingNeeds, type SettingsSection } from "../../lib/settingsSections";

const stroke = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** Each section's mark, in the menu and in the index. */
const ICON: Record<SettingsSection, ReactNode> = {
  profile: <svg {...stroke}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
  appearance: <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></svg>,
  notifications: <svg {...stroke}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>,
  media: <svg {...stroke}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" /></svg>,
  privacy: <svg {...stroke}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /></svg>,
  network: <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  storage: <svg {...stroke}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>,
  about: <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></svg>,
};

export function SectionIcon({ section, small = false }: { section: SettingsSection; small?: boolean }) {
  return (
    <span className={`grid place-items-center rounded-lg bg-accent/15 text-accent ${small ? "w-7 h-7 [&>svg]:w-4 [&>svg]:h-4" : "w-9 h-9"}`}>{ICON[section]}</span>
  );
}

/** The field that finds an option by its name. */
function SearchField({ value, onChange, testId }: { value: string; onChange: (value: string) => void; testId: string }) {
  const { t } = useI18n();
  return (
    <div className="relative">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
        className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}
        placeholder={t("settings.search")} aria-label={t("settings.search")}
        className="w-full min-w-0 ps-9 pe-3 py-2 min-h-10 bg-input-bg border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent" />
    </div>
  );
}

/** What a search found: each option with its section's name, or a line saying nothing matched. */
function SearchResults({ query, has, onOpen }: { query: string; has: (needs: SettingNeeds) => boolean; onOpen: (section: SettingsSection) => void }) {
  const { t } = useI18n();
  const found = searchSettings(query, t, has);
  if (!found.length) return <p role="status" data-testid="settings-search-empty" className="px-1 text-sm text-text-muted">{t("settings.searchEmpty")}</p>;
  return (
    <div className="bg-surface rounded-xl divide-y divide-border" data-testid="settings-search-results">
      {found.map((entry) => (
        <LinkRow key={`${entry.section}:${entry.label}`} testId="settings-search-result" leading={<SectionIcon section={entry.section} small />}
          label={t(entry.label)} hint={t(SECTION_TITLE[entry.section])} onClick={() => onOpen(entry.section)} />
      ))}
    </div>
  );
}

/**
 * A phone's Settings: a search field, then one line per section (its mark, its name, what it holds now) that opens
 * the section on a screen of its own. `top` is what comes before the sections (the profile's own line).
 */
export function SettingsMenu({ top, summary, shown, has, onOpen }: {
  top?: ReactNode;
  summary: Partial<Record<SettingsSection, ReactNode>>;
  /** Whether a section has anything on this device. */
  shown: (section: SettingsSection) => boolean;
  has: (needs: SettingNeeds) => boolean;
  onOpen: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  return (
    <div className="space-y-6" data-testid="settings-menu">
      <SearchField value={query} onChange={setQuery} testId="settings-search" />
      {query.trim() ? <SearchResults query={query} has={has} onOpen={onOpen} /> : <>
        {top}
        <nav aria-label={t("settings.title")} className="bg-surface rounded-xl divide-y divide-border">
          {SETTINGS_SECTIONS.filter(shown).map((section) => (
            <LinkRow key={section} testId={`settings-open-${section}`} leading={<SectionIcon section={section} />} label={t(SECTION_TITLE[section])}
              hint={summary[section] ? <span className="block truncate">{summary[section]}</span> : undefined} onClick={() => onOpen(section)} />
          ))}
        </nav>
      </>}
    </div>
  );
}

/**
 * A wide screen's index of the sections, beside the page that holds them all: picking one scrolls to it. The
 * search field above it finds an option by name.
 */
export function SettingsIndex({ active, shown, has, onPick }: {
  active: SettingsSection | null;
  shown: (section: SettingsSection) => boolean;
  has: (needs: SettingNeeds) => boolean;
  onPick: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  return (
    <div className="space-y-3" data-testid="settings-index">
      <SearchField value={query} onChange={setQuery} testId="settings-index-search" />
      {query.trim() ? <SearchResults query={query} has={has} onOpen={(section) => { setQuery(""); onPick(section); }} /> : (
        <nav aria-label={t("settings.title")} className="space-y-0.5">
          {SETTINGS_SECTIONS.filter(shown).map((section) => (
            <button key={section} type="button" data-testid={`settings-index-${section}`} aria-current={active === section ? "true" : undefined} onClick={() => onPick(section)}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 min-h-10 rounded-lg text-start text-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                active === section ? "bg-surface text-text-primary font-medium" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`}>
              <SectionIcon section={section} small />
              <span className="min-w-0 break-words">{t(SECTION_TITLE[section])}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
