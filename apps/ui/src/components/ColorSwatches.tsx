import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { THEME_COLOR } from "../lib/profiles";
import { radioGroupKeys, radioTabStop } from "../lib/radioGroup";
import { COLOR_THEME_OPTIONS } from "../lib/settings";

/**
 * The color themes as round swatches, one of them ringed: the color is its own label, its name the tooltip. A radio
 * group: one Tab stop (the chosen theme), the arrows (swapped in a right-to-left page), Home and End move and choose.
 * Every swatch has a thin edge in the muted ink, 3:1 or more on the card in every theme, so a pale one (Monochrome's
 * grey, Cyan) still shows on a light card; the theme's own colour stays as it is.
 */
export function ColorSwatches({ label, testIdPrefix }: { label: string; testIdPrefix: string }) {
  const { t } = useI18n();
  const { settings, updateColorTheme } = useSettings();
  const stop = radioTabStop(COLOR_THEME_OPTIONS.map(option => ({ checked: settings.colorTheme === option.value, disabled: false })));
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label} onKeyDown={e => radioGroupKeys(e, { choose: true })}>
      {COLOR_THEME_OPTIONS.map((option, i) => {
        const name = t(option.labelKey as Parameters<typeof t>[0]);
        const on = settings.colorTheme === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} aria-label={name} title={name} data-testid={`${testIdPrefix}-${option.value}`}
            tabIndex={i === stop ? 0 : -1} onClick={() => updateColorTheme(option.value)}
            className={`w-8 h-8 rounded-full transition-transform cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${on ? "border-2 border-text-primary scale-110" : "border border-text-muted hover:scale-105"}`}
            style={{ background: THEME_COLOR[option.value] }} />
        );
      })}
    </div>
  );
}
