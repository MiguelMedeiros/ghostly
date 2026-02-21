import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { Home } from "./pages/Home";
import { Chat } from "./pages/Chat";
import { setStorageProfile } from "./lib/storage";
import "./index.css";

async function boot() {
  try {
    const profile = await invoke<string>("get_profile");
    if (profile) {
      setStorageProfile(profile);
      console.log(`[boot] profile: ${profile}`);
    }
  } catch {
    // running outside Tauri (browser dev) — no profile
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <HashRouter>
        <Routes>
          <Route element={<App />}>
            <Route path="/" element={<Home />} />
            <Route path="/chat/*" element={<Chat />} />
          </Route>
        </Routes>
      </HashRouter>
    </StrictMode>,
  );
}

boot();
