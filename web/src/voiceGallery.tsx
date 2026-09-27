// Dev only (served by `npx vite web`, not in the build): the composer's voice recorder alone, for screenshots and
// scripts/voice-media/clicker.swift. `?tone` records a tone instead of the microphone; `&delay=ms` is a slow microphone.
// `window.sent` lists what was sent; `window.trace` the pointer, click and focus events.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SettingsProvider } from "../../src/contexts/SettingsContext";
import { ThemeProvider } from "../../src/contexts/ThemeContext";
import { I18nProvider } from "../../src/contexts/I18nContext";
import { MessageInput } from "../../src/components/MessageInput";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
const delay = Number(params.get("delay") ?? 0);
const w = window as unknown as { sent: { size: number; duration: number }[]; trace: string[] };
w.sent = [];
w.trace = [];
if (params.has("tone")) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
    await new Promise((r) => setTimeout(r, delay));
    const context = new AudioContext();
    const osc = context.createOscillator();
    const out = context.createMediaStreamDestination();
    osc.connect(out); osc.start();
    return out.stream;
  } } });
}
const t0 = performance.now();
for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "focusin", "focusout", "lostpointercapture", "gotpointercapture"]) {
  document.addEventListener(type, (e) => {
    const t = e.target as HTMLElement;
    const id = t?.closest?.("[data-testid]")?.getAttribute("data-testid") ?? t?.tagName;
    w.trace.push(`${Math.round(performance.now() - t0)} ${type} ${id}${"pointerType" in e ? " " + (e as PointerEvent).pointerType + " id=" + (e as PointerEvent).pointerId : ""}${e.defaultPrevented ? " prevented" : ""}`);
  }, true);
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <SettingsProvider>
      <ThemeProvider>
        <I18nProvider>
          <div className="h-screen w-screen flex flex-col justify-end" style={{ background: "var(--color-chat-bg, var(--color-app-bg))" }}>
            <div className="relative">
              <MessageInput onSend={async () => null} onSendFile={async (file, voice) => { w.sent.push({ size: file.size, duration: voice?.duration ?? 0 }); w.trace.push("SENT"); return null; }} />
            </div>
          </div>
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  </MemoryRouter>,
);
