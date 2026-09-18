import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { Root } from "./Root";
import { setStorageProfile } from "./lib/storage";

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
      <Root />
    </StrictMode>,
  );
}

boot();
