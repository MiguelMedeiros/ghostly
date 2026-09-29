import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { THEME_COLOR } from "../lib/profiles";
import { COLOR_THEME_OPTIONS } from "../lib/settings";

/** The color themes as round swatches, one of them ringed: the color is its own label, its name the tooltip. */
export function ColorSwatches({ label, testIdPrefix }: { label: string; testIdPrefix: string }) {
  const { t } = useI18n();
  const { settings, updateColorTheme } = useSettings();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {COLOR_THEME_OPTIONS.map((option) => {
        const name = t(option.labelKey as Parameters<typeof t>[0]);
        const on = settings.colorTheme === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} aria-label={name} title={name} data-testid={`${testIdPrefix}-${option.value}`}
            onClick={() => updateColorTheme(option.value)}
            className={`w-8 h-8 rounded-full border-2 transition-transform cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${on ? "border-text-primary scale-110" : "border-transparent hover:scale-105"}`}
            style={{ background: THEME_COLOR[option.value] }} />
        );
      })}
    </div>
  );
}
