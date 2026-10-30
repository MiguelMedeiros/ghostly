import { useI18n } from "../../contexts/I18nContext";
import { setTranslatesWhatISend, useTranslatesWhatISend } from "../../lib/chatTranslateSend";
import { MenuItem } from "../Menu";

/**
 * "Translate what I send", the chat's Translation sheet's last row (docs/AUTO-TRANSLATE.md § UI): this device's
 * choice for `chat`, off by default. It turns on and off in place; the sheet stays open.
 */
export function TranslateSendMenuItem({ chat }: { chat: string }) {
  const { t } = useI18n();
  const on = useTranslatesWhatISend(chat);
  return (
    <MenuItem testId="translate-send-switch" checked={on} hint={t("composer.translate.sendSettingHint")}
      icon={<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{on && <polyline points="20 6 9 17 4 12" />}</svg>}
      onClick={() => setTranslatesWhatISend(chat, !on)}>
      {t("composer.translate.sendSetting")}
    </MenuItem>
  );
}
