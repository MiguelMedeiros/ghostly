import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { transportLineDetails, type TransportEntry } from "../../lib/transportEvents";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { Settings } from "../../pages/Settings";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import { LANGUAGES, LOCALES } from "./locales";

// covers: services.open, chats.list.delete-all, transport.timeline

/** Counted strings said for a count of 1: each read "1 requests", "all 1 chats", "1 times" in every language. */
const ONE = {
  "services.requestCount": { en: "· 1 request", es: "· 1 solicitud", fr: "· 1 requête", it: "· 1 richiesta", pt: "· 1 pedido", ar: "· طلب واحد", ja: "· 1 件のリクエスト", zh: "· 1 次请求" },
  "settings.deleteAllChatsConfirm": {
    en: "Delete your only chat?", es: "¿Eliminar tu único chat?", fr: "Supprimer 1 discussion ?", it: "Eliminare l'unica chat?", pt: "Excluir 1 conversa?",
    ar: "حذف المحادثة الوحيدة؟", ja: "1件のチャットを削除しますか?", zh: "删除 1 个聊天?",
  },
  "connection.why.flapping": {
    en: "The live connection dropped and came back once between 14:00 and 14:05.",
    es: "La conexión directa se cayó y volvió una vez entre 14:00 y 14:05.",
    fr: "La liaison directe a coupé et est revenue 1 fois entre 14:00 et 14:05.",
    it: "La connessione diretta è caduta ed è tornata una volta tra 14:00 e 14:05.",
    pt: "A conexão direta caiu e voltou 1 vez entre 14:00 e 14:05.",
    ar: "انقطع الاتصال المباشر وعاد مرة واحدة بين 14:00 و14:05.",
    ja: "14:00 から 14:05 の間に、直接接続が 1 回切れて戻りました。",
    zh: "在 14:00 到 14:05 之间，直连断开又恢复了 1 次。",
  },
} as const;

const flapped: TransportEntry = { id: "f1", kind: "flapping", count: 1, live: false, since: 0, at: 5 * 60_000 };
const clock = (at: number) => (at === 0 ? "14:00" : "14:05");

describe("a counted string said for 1, in every language", () => {
  it.each(LANGUAGES)("%s: one pending request on Services, Delete all chats with one chat, a link that came back once", (language) => {
    const t = translateWith(LOCALES[language], language);
    expect(t("services.requestCount", { count: 1 })).toBe(ONE["services.requestCount"][language]);
    expect(t("settings.deleteAllChatsConfirm", { count: 1 })).toBe(ONE["settings.deleteAllChatsConfirm"][language]);
    const why = transportLineDetails(flapped, "Ana", clock, t).find((row) => row.label === t("connection.detail.why"))!.value;
    expect(why).toBe(ONE["connection.why.flapping"][language]);
  });

  it("Services: an app with one pending request", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.update({ services: [{ id: "mine", name: "Album", target: "http://localhost:3400", enabled: true, requests: 1, createdAt: 1 }] });
      renderApp(<Services />);
      expect(within(await screen.findByTestId("service-item")).getByText("· 1 request")).toBeInTheDocument();
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });

  it("Settings > Delete all chats with one chat", async () => {
    windowIs(false);
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "a".repeat(52), encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 } satisfies ChatSession);
    const { user } = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>, { route: "/settings/storage" });
    const remove = await screen.findByTestId("delete-all-chats");
    await vi.waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);
    expect(screen.getByText("Delete your only chat?")).toBeInTheDocument();
  });
});
