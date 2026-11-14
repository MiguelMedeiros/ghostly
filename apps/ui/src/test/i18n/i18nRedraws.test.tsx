import { memo, useEffect, useRef } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSettings } from "../../contexts/SettingsContext";
import { useI18n, useT } from "../../contexts/I18nContext";
import { useTranslation } from "../../hooks/useTranslation";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.i18n

/** Draws of each, counted as they reach the page. */
const draws = { t: 0, i18n: 0, translated: 0 };

/** Stands in for a message bubble: memoized, it reads only the translator. */
const Bubble = memo(function Bubble() {
  useEffect(() => { draws.t++; });
  return <p>{useT()("settings.title")}</p>;
});

/** And for one that reads the language too. */
const Row = memo(function Row() {
  useEffect(() => { draws.i18n++; });
  const { t, dir } = useI18n();
  return <p dir={dir}>{t("settings.title")}</p>;
});

const MESSAGE: ChatMessage = { id: "m1", text: "hola", sender: "peer", timestamp: 1 };

/** And for a bubble's translation, which reads the Settings switch. */
const Translated = memo(function Translated() {
  useEffect(() => { draws.translated++; });
  const ref = useRef<HTMLParagraphElement>(null);
  useTranslation(MESSAGE, ref, true);
  return <p ref={ref}>{MESSAGE.text}</p>;
});

/** Stands in for the chat list's collapse button and the Language select. */
function Switches() {
  const { settings, updateChatListCollapsed, updateLanguage } = useSettings();
  return (
    <>
      <button onClick={() => updateChatListCollapsed(!settings.chatListCollapsed)}>collapse</button>
      <button onClick={() => updateLanguage("pt")}>pt</button>
    </>
  );
}

describe("what a message reads from the settings", () => {
  it("a setting other than the language draws no message again: translations and the translate switch alike", async () => {
    Object.assign(draws, { t: 0, i18n: 0, translated: 0 });
    const { user } = renderApp(<><Switches /><Bubble /><Row /><Translated /></>);
    expect(draws).toEqual({ t: 1, i18n: 1, translated: 1 });

    await user.click(screen.getByRole("button", { name: "collapse" }));
    await user.click(screen.getByRole("button", { name: "collapse" }));
    expect(draws).toEqual({ t: 1, i18n: 1, translated: 1 });

    // The language itself still reaches them.
    await user.click(screen.getByRole("button", { name: "pt" }));
    expect(await screen.findAllByText("Ajustes")).toHaveLength(2);
  });
});
