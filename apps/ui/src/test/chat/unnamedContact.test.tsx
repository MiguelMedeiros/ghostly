import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Language } from "../../lib/settings";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { liveAttemptText, transportEventText, transportWaitText, type TransportEvent } from "../../lib/transportEvents";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "../i18n/locales";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.wait, transport.indicator

type Pairing = NonNullable<LinkView["pairing"]>;
type Wait = NonNullable<LinkView["transportWait"]>;

/** A contact who shared no name: the Details text says "your contact" in whole sentences, never the fallback name. */
describe("the connection Details of a contact with no name", () => {
  const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved",
    pairing: { status: "connecting" } as Pairing };
  function panel(link: Partial<LinkView>, language?: Language) {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language });
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1", "iroh/1"], ...onDht, ...link })] }));
    return view;
  }
  const lines = (testId: string) => [...screen.getByTestId(testId).querySelectorAll("p")].map(p => p.textContent);

  it.each<[Language, string[]]>([
    ["en", ["Not live yet", "Your contact's app connects to this one: this app answers.", "No attempt from your contact has reached this app yet."]],
    ["pt", ["Ainda sem conexão direta", "O app do seu contato conecta a este: este app responde.", "Nenhuma tentativa do seu contato chegou a este app ainda."]],
    ["zh", ["尚未直连", "你的联系人的应用会连接到本应用：本应用负责应答。", "你的联系人的连接尝试尚未到达本应用。"]],
  ])("says in %s why it is not live in whole sentences", (language, expected) => {
    panel({ liveDialer: "contact" }, language);
    expect(lines("connection-not-live")).toEqual(expected);
  });

  it("says what of the contact's attempt reached this app, and what the chat waits for", () => {
    panel({ liveDialer: "contact", liveAttempt: { at: 1, side: "answered", failed: [{ transport: "webrtc/1", error: "No connection came up" }] },
      transportWait: { transport: "iroh/1", by: "contact", reason: "starting", failures: 0 } as Wait }, "pt");
    expect(lines("connection-not-live").slice(1, 3)).toEqual(["O app do seu contato conecta a este: este app responde.",
      "A última tentativa do seu contato chegou a este app e não conectou:"]);
    expect(within(screen.getByTestId("connection-waiting")).getByTestId("connection-waiting-why"))
      .toHaveTextContent("Seu contato escolheu Iroh. O Iroh do seu contato está iniciando.");
  });

  // Every line the Details box can say with the contact in it, in every language. The fallback ("Your contact", "Il
  // tuo contatto") only ever opens a sentence where a name would; in Chinese and Japanese no space sits beside it (the
  // space a Latin name gets; the " · " between a line's parts aside); and nothing of "{{contact}}" or an "undefined" is left.
  const events: TransportEvent[] = [
    { at: 1, kind: "down", from: "webrtc/1", text: "hold" },
    { at: 1, kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "contact" },
    { at: 1, kind: "chose", cause: "contact", target: "iroh/1" },
    { at: 1, kind: "chose", cause: "contact" },
    { at: 1, kind: "dht-only", cause: "contact" },
  ];
  const waits: Wait[] = (["unknown", "starting", "waiting", "contact-lacks"] as const).map(reason => ({ transport: "iroh/1", by: "contact", reason, failures: 0 }));
  it.each(LANGUAGES)("never drops the fallback name into a sentence in %s", (language) => {
    const t = translateWith(LOCALES[language], language), fallback = t("pairing.contact");
    panel({ liveDialer: "contact", liveAttempt: { at: 1, side: "answered", failed: [] }, transportWait: waits[1], transportHistory: events }, language);
    const said = [
      ...lines("connection-not-live"), ...lines("connection-waiting"),
      ...screen.getAllByTestId("connection-history-event").map(e => e.querySelector("span")!.textContent!),
      ...liveAttemptText(undefined, "contact", undefined, () => "17:02", t)!.lines,
      ...waits.map(w => transportWaitText(w, undefined, () => "17:02", t).why),
      ...events.map(e => transportEventText(e, undefined, t)),
    ];
    expect(said.length).toBeGreaterThan(15);
    const cjk = language === "zh" || language === "ja";
    for (const line of said) {
      expect([language, line]).not.toEqual([language, expect.stringMatching(/\{\{|\}\}|undefined/)]);
      if (cjk) expect([language, line]).not.toEqual([language, expect.stringMatching(new RegExp(`${fallback} |(?<!·) ${fallback}`))]);
      else if (language !== "ar") expect([language, line, "mid-sentence", line!.indexOf(fallback) > 0]).toEqual([language, line, "mid-sentence", false]);
    }
  });

  it("keeps the contact's name when there is one", () => {
    panel({ liveDialer: "contact", peerNick: "Bea" });
    expect(lines("connection-not-live").slice(1)).toEqual(["Bea's app connects to this one: this app answers.", "No attempt of Bea's has reached this app yet."]);
  });
});
