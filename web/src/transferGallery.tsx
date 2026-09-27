// Dev only (served by `npx vite web`, not in the build): a file and a voice note in every state a transfer shows, on
// both bubbles, for screenshots. `?theme=light|dark`. Pressing a round button moves that row to "retrying".
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { SettingsProvider } from "../../src/contexts/SettingsContext";
import { I18nProvider } from "../../src/contexts/I18nContext";
import { FileBubble } from "../../src/components/FileBubble";
import { VoiceBubble } from "../../src/components/voice/VoiceBubble";
import { servicesPlatform, type FileTransferState } from "../../src/lib/platform";
import type { ChatFile } from "../../src/lib/types";
import "../../src/index.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";

const SIZE = 115_395;
const peaks = Array.from({ length: 64 }, (_, i) => Math.round(60 + 160 * Math.abs(Math.sin(i / 4))));
const rows: { name: string; out: FileTransferState | null; in: FileTransferState | null }[] = [
  { name: "sending", out: { state: "transferring", direction: "out", transferred: SIZE * 0.42, size: SIZE, rate: 48_000 }, in: { state: "transferring", direction: "in", transferred: SIZE * 0.42, size: SIZE } },
  { name: "stalled", out: { state: "transferring", direction: "out", transferred: SIZE * 0.14, size: SIZE, stalled: true }, in: { state: "transferring", direction: "in", transferred: SIZE * 0.28, size: SIZE, stalled: true } },
  { name: "failed", out: { state: "failed", direction: "out", transferred: 0, size: SIZE, retry: true, error: "Could not read the file: The object can not be found here." },
    in: { state: "failed", direction: "in", transferred: 0, size: SIZE, error: "Cancelled by the sender" } },
  { name: "retrying", out: { state: "transferring", direction: "out", transferred: SIZE * 0.05, size: SIZE }, in: { state: "transferring", direction: "in", transferred: SIZE * 0.05, size: SIZE } },
  { name: "incoming partial, link down", out: { state: "transferring", direction: "out", stage: "waiting", transferred: SIZE * 0.28, size: SIZE, stalled: true },
    in: { state: "transferring", direction: "in", stage: "waiting", transferred: SIZE * 0.28, size: SIZE, stalled: true } },
];
const transfers = new Map<string, FileTransferState | null>();
rows.forEach((row, i) => {
  for (const kind of ["voice", "file"]) {
    transfers.set(`g-out-${kind}${i}`, row.out);
    transfers.set(`g-in-${kind}${i}`, row.in);
  }
});
const listeners = new Set<() => void>();
const retrying = (id: string) => {
  transfers.set(id, { ...rows[3][id.includes("-out-") ? "out" : "in"]! });
  for (const listener of listeners) listener();
};
Object.assign(servicesPlatform!, {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  getTransfer: (id: string) => transfers.get(id) ?? null,
  getFile: async () => null,
  retryFile: async (id: string) => retrying(id),
  fileAction: async (id: string) => retrying(id),
});

const voice = (id: string): ChatFile & { voice: { duration: number; peaks: number[] } } =>
  ({ id, name: "Voice message.webm", size: SIZE, mime: "audio/webm", voice: { duration: 19_000, peaks } });
const file = (id: string): ChatFile => ({ id, name: "season notes.pdf", size: SIZE, mime: "application/pdf" });
const bubble = (me: boolean, children: ReactNode) => (
  <div className={`max-w-[330px] px-[9px] pt-[6px] pb-[8px] rounded-[7.5px] text-text-primary ${me ? "bg-sent-bg justify-self-end" : "bg-received-bg justify-self-start"}`}
    style={{ boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)" }}>{children}</div>
);

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <SettingsProvider>
      <I18nProvider>
        <div className="min-h-screen p-4 text-text-primary" style={{ background: "var(--color-chat-bg, var(--color-app-bg))" }} data-testid="gallery">
          {rows.map((row, i) => (
            <section key={row.name} className="mb-4">
              <h2 className="text-xs uppercase tracking-wide text-text-secondary m-0 mb-1">{row.name}</h2>
              <div className="grid grid-cols-2 gap-2 items-start">
                {bubble(true, <VoiceBubble file={voice(`g-out-voice${i}`)} sender="me" peerName="Ana" />)}
                {bubble(false, <VoiceBubble file={voice(`g-in-voice${i}`)} sender="peer" peerName="Ana" />)}
                {bubble(true, <FileBubble file={file(`g-out-file${i}`)} peerName="Ana" />)}
                {bubble(false, <FileBubble file={file(`g-in-file${i}`)} peerName="Ana" />)}
              </div>
            </section>
          ))}
        </div>
      </I18nProvider>
    </SettingsProvider>
  </MemoryRouter>,
);
