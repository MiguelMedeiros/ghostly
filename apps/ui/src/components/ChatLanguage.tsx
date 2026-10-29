import type { RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { chatLanguageOf, languageChoices, languageName, setChatLanguage, useChatLanguage, type ChatLanguage } from "../lib/chatLanguage";
import { translateEnabled } from "../lib/translateFlag";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

/*
 * A chat's language (apps/ui/src/lib/chatLanguage.ts) in the chat's Translation sheet: the row that names it, "Language
 * of this chat: Italian (detected) · Change", and the languages Change offers. `chat` is a session id, or
 * `groupChat(id)` for a group; `detected` the confident language of each of the others' messages, oldest first.
 * Nothing shows while the build has no translation (lib/translateFlag.ts).
 */

type ChatLanguageProps = { chat: string; detected: readonly (string | null | undefined)[]; group: boolean };

export function LanguageIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h8M8 3v2M6 5c0 4 2.5 7 6 8M10 5c0 3-2.5 6.5-6 8" />
      <path d="M12 21l4.5-10L21 21M13.5 18h6" />
    </svg>
  );
}

/** "Italian (detected)", "French (set by you)", "Several languages" or "Not known yet". */
function useLanguageText() {
  const { t, language: app } = useI18n();
  return ({ language, by }: Pick<ChatLanguage, "language" | "by">, group: boolean) => {
    if (!language) return group ? t("chatLanguage.several") : t("chatLanguage.unknown");
    return t(by === "hand" ? "chatLanguage.byHand" : "chatLanguage.detected", { language: languageName(language, app) });
  };
}

/** The sheet's row: the chat's language, and Change, which opens the languages (`onChoose`). */
export function ChatLanguageMenuItem({ chat, detected, group, onChoose }: ChatLanguageProps & { onChoose(): void }) {
  const { t } = useI18n();
  const current = useChatLanguage(chat, detected, group);
  const text = useLanguageText();
  if (!translateEnabled()) return null;
  return (
    <MenuItem testId="chat-language-open" icon={<LanguageIcon />} hint={`${text(current, group)} · ${t("chatLanguage.change")}`} onClick={onChoose}>
      {t("chatLanguage.title")}
    </MenuItem>
  );
}

type ChatLanguageMenuProps = ChatLanguageProps & {
  open: boolean; onClose(): void; anchorRef: RefObject<HTMLElement | null>; align?: "start" | "end"; portal?: boolean;
};

/**
 * What the chat's language can be: worked out from the others' messages (the default), or one set by hand, the
 * chat's own languages first, then the app's.
 */
export function ChatLanguageMenu(props: ChatLanguageMenuProps) {
  return props.open && translateEnabled() ? <OpenChatLanguageMenu {...props} /> : null;
}

function OpenChatLanguageMenu({ chat, detected, group, open, onClose, anchorRef, align, portal }: ChatLanguageMenuProps) {
  const { t, language: app } = useI18n();
  const current = useChatLanguage(chat, detected, group);
  const text = useLanguageText();
  const choose = (language: string | null) => { setChatLanguage(chat, language); onClose(); };
  return (
    <Menu testId="chat-language-menu" open={open} onClose={onClose} anchorRef={anchorRef} align={align} portal={portal} focusFirst label={t("chatLanguage.title")}>
      <div className="px-3 pb-1 pt-1.5 text-xs text-text-muted">
        <span className="block truncate whitespace-nowrap font-medium text-text-primary">{t("chatLanguage.title")}</span>
        <span className="block">{t("chatLanguage.note")}</span>
      </div>
      <MenuItem testId="chat-language-auto" checked={current.by !== "hand"} hint={text(chatLanguageOf(detected, { group }), group)} onClick={() => choose(null)}>
        {t("chatLanguage.auto")}
      </MenuItem>
      <MenuSeparator />
      {languageChoices(current.languages).map(code => (
        <MenuItem key={code} testId={`chat-language-${code}`} data={{ "data-language": code }} checked={current.by === "hand" && current.language === code} onClick={() => choose(code)}>
          {languageName(code, app)}
        </MenuItem>
      ))}
    </Menu>
  );
}
