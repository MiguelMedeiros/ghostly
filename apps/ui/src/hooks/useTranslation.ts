import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { chatTranslateChoice, translatesChat, watchChatTranslate } from "../lib/chatTranslate";
import { useCueChat } from "../lib/cues";
import { languageName } from "../lib/documentLanguage";
import { isDesktopApp } from "../lib/externalLink";
import { translateEnabled } from "../lib/translateFlag";
import { askTranslation, readTranslation, showOriginal, shownOriginal, translationRound, watchTranslations } from "../lib/translateReceived";
import type { ChatMessage } from "../lib/types";

/** A received message's translation, as its bubble shows it (lib/translateReceived.ts). */
export interface ShownTranslation {
  /** The language it was written in, by name, in the app's language. */
  language: string;
  /** The translation, once it came; the original is shown until then. */
  text?: string;
  /** Too long to be translated by itself: Translate (`translate`) asks for it. */
  long: boolean;
  /** Show original was pressed: the original is shown, with Show translation. */
  original: boolean;
  toggle: () => void;
  translate: () => void;
}

/** How far past the list's edges a bubble counts as on screen: the next screenful, so scrolling finds it translated. */
const NEAR = "100% 0px";

/** One observer per message list, for every bubble in it that waits to be seen. */
const observers = new Map<Element | null, { observer: IntersectionObserver; seen: Map<Element, (visible: boolean) => void> }>();

function watchOnScreen(el: Element, onChange: (visible: boolean) => void): () => void {
  const root = el.closest("[data-message-list]");
  let watching = observers.get(root);
  if (!watching) {
    const seen = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver((entries) => { for (const e of entries) seen.get(e.target)?.(e.isIntersecting); }, { root, rootMargin: NEAR });
    observers.set(root, watching = { observer, seen });
  }
  const { observer, seen } = watching;
  seen.set(el, onChange);
  observer.observe(el);
  return () => {
    seen.delete(el);
    observer.unobserve(el);
    if (!seen.size) { observer.disconnect(); observers.delete(root); }
  };
}

/** Whether `ref`'s element is on screen or a screenful away, watched only while `active`. */
function useNearScreen(ref: RefObject<Element | null>, active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    return watchOnScreen(el, setVisible);
  }, [ref, active]);
  return active && (visible || typeof IntersectionObserver === "undefined");
}

const idle = () => () => {};

/**
 * `message` in the app's language, when it is a contact's or a member's text (`eligible`: a plain text body), the
 * chat translates (lib/chatTranslate.ts: its own choice, or the Settings switch), and the build and the device have translation (`VITE_TRANSLATE`, Desktop). It is
 * asked for once the bubble (`ref`) comes near the screen, never before; null while there is nothing to show.
 */
export function useTranslation(message: ChatMessage, ref: RefObject<Element | null>, eligible: boolean): ShownTranslation | null {
  const chat = useCueChat();
  const { language } = useI18n();
  const { settings } = useSettings();
  const able = eligible && message.sender === "peer" && !!chat && translateEnabled() && isDesktopApp();
  // Only a bubble that could translate watches the chat's choice: "settings" for the rest, which reads no key.
  const choice = useSyncExternalStore(able ? watchChatTranslate : idle, () => (able ? chatTranslateChoice(chat!) : "settings"));
  const on = able && translatesChat(choice, settings.translateMessages);
  const near = useNearScreen(ref, on);
  // After a model is downloaded or removed (`forgetTranslations`), what is on screen is asked again.
  const round = useSyncExternalStore(on ? watchTranslations : idle, () => (on ? translationRound() : 0));
  useEffect(() => {
    if (on && near) askTranslation(message, chat!, language);
  }, [on, near, message, chat, language, round]);
  const translation = useSyncExternalStore(on ? watchTranslations : idle, () => (on ? readTranslation(message, language) : null));
  const original = useSyncExternalStore(on ? watchTranslations : idle, () => on && shownOriginal(message.id));
  if (!translation) return null;
  return {
    language: languageName(translation.from, language),
    text: translation.text,
    long: translation.long,
    original,
    toggle: () => showOriginal(message.id, !original),
    translate: () => askTranslation(message, chat!, language, true),
  };
}
