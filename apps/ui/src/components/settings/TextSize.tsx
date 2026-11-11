import { useSettings } from "../../contexts/SettingsContext";
import { useI18n } from "../../contexts/I18nContext";
import { Row } from "../layout";
import { TEXT_SIZES } from "../../lib/textSize";

/**
 * Settings → Appearance → Text size: five steps from Small to Huge on a slider between a small and a large "A", as a
 * phone's own text size, with two messages under it drawn at the size chosen (the same classes as a chat's).
 */
export function TextSizeSetting() {
  const { t } = useI18n();
  const { settings, updateTextSize } = useSettings();
  const step = TEXT_SIZES.indexOf(settings.textSize);
  const name = t(`settings.textSizes.${settings.textSize}` as const);
  return (
    <div data-testid="settings-text-size-row">
      <Row label={t("settings.textSize")} hint={t("settings.textSizeHint")} value={<span data-testid="settings-text-size-value">{name}</span>} />
      <div className="px-4 pb-4 -mt-1 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-text-secondary">A</span>
          <input type="range" data-testid="settings-text-size" min={0} max={TEXT_SIZES.length - 1} step={1} value={step}
            aria-label={t("settings.textSize")} aria-valuetext={name}
            onChange={(e) => updateTextSize(TEXT_SIZES[Number(e.target.value)] ?? "default")}
            className="flex-1 min-w-0 h-11 accent-accent cursor-pointer" />
          <span aria-hidden="true" className="shrink-0 text-xl font-semibold text-text-secondary">A</span>
        </div>
        {/* What a chat looks like at this size: a contact's message and an answer. */}
        <div data-testid="settings-text-size-preview" aria-hidden="true" className="flex flex-col gap-1.5 rounded-lg bg-chat-bg p-3">
          <p dir="auto" className="m-0 max-w-[85%] self-start rounded-lg rounded-ss-none bg-received-bg px-2.5 py-1.5 chat-text-message text-text-primary wrap-break-word">
            {t("settings.textSizePreview")}
          </p>
          <p dir="auto" className="m-0 max-w-[85%] self-end rounded-lg rounded-se-none bg-sent-bg px-2.5 py-1.5 chat-text-message text-text-primary wrap-break-word">
            {t("settings.textSizePreviewReply")}
          </p>
        </div>
      </div>
    </div>
  );
}
