/**
 * Chess, a Ghostly mini-app. The runner gives it `window.ghostly` (the broker, see @ghostly/core/miniApp); opened
 * outside the runner in a dev server, it plays alone on a stand-in broker that keeps nothing.
 */
import type { MiniAppApi } from "@ghostly/core/miniApp";
import { ChessController } from "./game.ts";
import { pickLanguage, stringsFor } from "./strings.ts";
import { mountChess } from "./ui.ts";
import "./style.css";

/** A broker that keeps nothing, for `vite` in a browser tab. */
function standIn(): MiniAppApi {
  const store = new Map<string, unknown>();
  return {
    context: async () => ({ version: "dev", inChat: false, peer: null }),
    file: async () => new ArrayBuffer(0),
    storage: {
      get: async (key) => store.get(key) as never,
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    chat: { send: async () => Promise.reject(new Error("not in a chat")), on: () => () => {} },
    close: async () => {},
  };
}

async function main(): Promise<void> {
  const root = document.getElementById("app")!;
  const api = (window as { ghostly?: MiniAppApi }).ghostly ?? standIn();
  const context = await api.context();
  const dark = context.theme ? context.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const language = pickLanguage(context.locale ?? navigator.language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  const strings = stringsFor(language);
  document.title = strings.title;
  const game = new ChessController(api);
  mountChess(root, game, strings);
  try {
    await game.start();
  } catch (error) {
    root.textContent = String(error instanceof Error ? error.message : error);
  }
}

void main();
