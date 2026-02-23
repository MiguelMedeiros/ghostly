import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { Home } from "./pages/Home";
import { Chat } from "./pages/Chat";
import { Settings } from "./pages/Settings";
import { setStorageProfile } from "./lib/storage";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./contexts/I18nContext";
import { LockScreenProvider } from "./contexts/LockScreenContext";
import { LockScreen } from "./components/LockScreen";
import "./index.css";

async function boot() {
  try {
    const profile = await invoke<string>("get_profile");
    if (profile) {
      setStorageProfile(profile);
    }
  } catch {
    // running outside Tauri (browser dev) — no profile
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SettingsProvider>
        <ThemeProvider>
          <I18nProvider>
            <LockScreenProvider>
              <LockScreen />
              <HashRouter>
                <Routes>
                  <Route element={<App />}>
                    <Route path="/" element={<Home />} />
                    <Route path="/chat/*" element={<Chat />} />
                    <Route path="/settings" element={<Settings />} />
                  </Route>
                </Routes>
              </HashRouter>
            </LockScreenProvider>
          </I18nProvider>
        </ThemeProvider>
      </SettingsProvider>
    </StrictMode>,
  );
}

boot();
