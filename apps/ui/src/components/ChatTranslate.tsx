import { useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { isGroupChat } from "../lib/chatLanguage";
import { TRANSLATE_CHOICES, setChatTranslate, useChatTranslate, type ChatTranslateChoice } from "../lib/chatTranslate";
import { chatLanguageNow, useChatDetections } from "../lib/translateReceived";
import { translateOffered } from "../lib/translateSettings";
import { ChatLanguageMenu, ChatLanguageMenuItem } from "./ChatLanguage";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { useTranslateDownload } from "../hooks/useTranslateDownload";
import { TranslateSendMenuItem } from "./chat/TranslateSendMenuItem";

/*
 * A chat's translation, On, Off or As in Settings (apps/ui/src/lib/chatTranslate.ts): the row in the chat's ⋮ menu
 * and the sheet of choices it opens. Only where Settings offers translation (lib/translateSettings.ts: a
 * `VITE_TRANSLATE` build of the Desktop app). `chat` is a session id, or `groupChat(id)` for a group.
 */

function TranslateIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
    </svg>
  );
}

/** A choice as the menu names it: As in Settings says what Settings says now. */
function useChoiceText() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const state = t(settings.translateMessages ? "chatTranslate.choice.on" : "chatTranslate.choice.off");
  return (choice: ChatTranslateChoice) => choice === "settings" ? t("chatTranslate.choice.settings", { state }) : t(`chatTranslate.choice.${choice}`);
}

/** The chat's ⋮ menu row, "Translation…" with the chat's choice under it: opens the choices (`onChoose`). */
export function TranslateMenuItem({ chat, onChoose }: { chat: string; onChoose(): void }) {
  const { t } = useI18n();
  const choice = useChatTranslate(chat);
  const choiceText = useChoiceText();
  if (!translateOffered()) return null;
  return <MenuItem testId="chat-translate-open" icon={<TranslateIcon />} hint={choiceText(choice)} onClick={onChoose}>{t("chatTranslate.open")}</MenuItem>;
}

type TranslateMenuProps = { chat: string; open: boolean; onClose(): void; anchorRef: RefObject<HTMLElement | null> };

/**
 * The three choices, the chat's own ticked, and the chat's language with Change (components/ChatLanguage.tsx).
 * Choosing one sets it and closes the sheet. On asks for the models reading the chat's language takes; with no
 * language known yet, it asks as the Settings switch does, and only while the switch is off. The question and the
 * languages outlive the sheet.
 */
export function TranslateMenu(props: TranslateMenuProps) {
  const { chat, anchorRef } = props;
  const { settings } = useSettings();
  const { ask, question } = useTranslateDownload();
  const [languages, setLanguages] = useState(false);
  const detected = useChatDetections(chat);
  if (!translateOffered()) return null;
  const chosen = (choice: ChatTranslateChoice) => {
    const { language } = chatLanguageNow(chat);
    if (choice === "on" && (language || !settings.translateMessages)) void ask(settings.language, language);
  };
  const language = { chat, detected, group: isGroupChat(chat) };
  return <>
    {props.open && <OpenTranslateMenu {...props} onChosen={chosen} language={<ChatLanguageMenuItem {...language} onChoose={() => { props.onClose(); setLanguages(true); }} />} />}
    <ChatLanguageMenu {...language} open={languages} onClose={() => setLanguages(false)} anchorRef={anchorRef} />
    {question}
  </>;
}

function OpenTranslateMenu({ chat, open, onClose, anchorRef, onChosen, language }: TranslateMenuProps & { onChosen(choice: ChatTranslateChoice): void; language: ReactNode }) {
  const { t } = useI18n();
  const choice = useChatTranslate(chat);
  const choiceText = useChoiceText();
  return (
    <Menu testId="translate-menu" open={open} onClose={onClose} anchorRef={anchorRef} focusFirst label={t("chatTranslate.title")}>
      {/* Not a row: the note may wrap on a narrow sheet rather than be cut. */}
      <div className="px-3 pb-1 pt-1.5 text-xs text-text-muted">
        <span className="block truncate whitespace-nowrap font-medium text-text-primary">{t("chatTranslate.title")}</span>
        <span className="block">{t("chatTranslate.note")}</span>
      </div>
      {TRANSLATE_CHOICES.map(each => (
        <MenuItem key={each} testId={`translate-${each}`} checked={each === choice}
          icon={<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{each === choice && <polyline points="20 6 9 17 4 12" />}</svg>}
          onClick={() => { setChatTranslate(chat, each); onClose(); onChosen(each); }}>
          {choiceText(each)}
        </MenuItem>
      ))}
      <MenuSeparator />
      {language}
      <TranslateSendMenuItem chat={chat} />
    </Menu>
  );
}
