// The film page: the app's own components, drawn from the film's time. render.mjs opens it, calls
// `window.seek(t)` and takes a screenshot for every frame. `?t=12.5` shows one moment, `?format=9x16` or `1x1`
// the other layouts.
import "../../../src/index.css";
import "./film.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { SettingsProvider } from "../../../src/contexts/SettingsContext";
import { I18nProvider } from "../../../src/contexts/I18nContext";
import { fakeEngine, installFakeEngine } from "../../../src/test/fakeEngine";
import type { NetworkWalletsView, WalletView } from "@ghostly/browser/shared/types";
import { Film, FORMATS, type Format } from "./Film";

declare global {
  interface Window { seek: (t: number) => Promise<void>; ready: boolean; format: Format }
}

const params = new URLSearchParams(location.search);
const format = (params.get("format") ?? "16x9") as Format;
window.format = format;
localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en", colorScheme: "dark", colorTheme: "classic", reduceMotion: false }));
await installFakeEngine();
// A Testnet on-chain wallet, so the chat's Bitcoin link is one this profile can pay.
const empty = { mints: [], balance: 0, history: [], feesPaid: 0 } as unknown as NetworkWalletsView;
const bitcoin = { status: "ready", providerId: "bdk", label: "BDK wallet", network: "signet", balance: 1_000_000, history: [] } as unknown as NetworkWalletsView["bitcoin"];
fakeEngine.setState({ wallet: { networks: { mainnet: empty, testnet: { ...empty, bitcoin } } } as unknown as WalletView });

let setTime: (t: number) => void = () => {};
function App() {
  const [t, setT] = useState(Number(params.get("t") ?? 0));
  setTime = setT;
  return (
    <MemoryRouter>
      <SettingsProvider>
        <I18nProvider>
          <Film t={t} format={format} />
        </I18nProvider>
      </SettingsProvider>
    </MemoryRouter>
  );
}

const [width, height] = FORMATS[format];
document.documentElement.style.setProperty("--film-w", `${width}px`);
document.documentElement.style.setProperty("--film-h", `${height}px`);
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
window.seek = async (t: number) => {
  flushSync(() => setTime(t));
  await frame();
};
await document.fonts.ready;
// Every scene is mounted from the start (hidden until its time): give lazy parts (the code highlighter) their load.
await new Promise((resolve) => setTimeout(resolve, 1500));
await window.seek(Number(params.get("t") ?? 0));
window.ready = true;
