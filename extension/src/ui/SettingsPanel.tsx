import { useState } from "react";
import { DEFAULT_RELAYS } from "@ghostly/core";
import type { Engine } from "./useEngine";

export function SettingsPanel({ engine }: { engine: Engine }) {
  const { state, call } = engine;
  const [nick, setNick] = useState(state?.settings.nick ?? "");
  const [relays, setRelays] = useState((state?.settings.relays ?? []).join("\n"));
  const [turn, setTurn] = useState(state?.settings.iceServers[0] ?? { urls: "", username: "", credential: "" });
  const [saved, setSaved] = useState(false);
  if (!state) return null;

  const save = async () => {
    await call("updateSettings", {
      settings: {
        nick: nick.trim().slice(0, 32),
        relays: relays.split(/\s+/).filter(Boolean),
        iceServers: turn.urls.trim() ? [{ ...turn, urls: turn.urls.trim() }] : [],
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const field = "w-full rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-ghost";
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <h2 className="text-xl font-semibold">Settings</h2>

      <label className="flex flex-col gap-1 text-sm">
        Nickname
        <input className={field} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Shown to your peers" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Pkarr relays
        <textarea className={`${field} h-24 font-mono`} value={relays} onChange={(e) => setRelays(e.target.value)} />
        <span className="text-xs text-mist">
          Browsers cannot speak to the Mainline DHT directly, relays do it for them. They only see signed, encrypted
          packets and never carry your traffic. One per line; every relay is used.{" "}
          <button type="button" className="underline" onClick={() => setRelays(DEFAULT_RELAYS.join("\n"))}>
            Reset
          </button>
        </span>
      </label>

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1">TURN server (optional)</legend>
        <input className={`${field} font-mono`} placeholder="turn:turn.example.org:3478" value={turn.urls} onChange={(e) => setTurn({ ...turn, urls: e.target.value })} />
        <div className="flex gap-2">
          <input className={field} placeholder="Username" value={turn.username ?? ""} onChange={(e) => setTurn({ ...turn, username: e.target.value })} />
          <input className={field} placeholder="Credential" type="password" value={turn.credential ?? ""} onChange={(e) => setTurn({ ...turn, credential: e.target.value })} />
        </div>
        <span className="text-xs text-mist">
          Only used when a direct connection is impossible. TURN relays encrypted WebRTC packets; it is connectivity
          infrastructure, not a Ghostly server.
        </span>
      </fieldset>

      <div className="flex items-center gap-3">
        <button className="rounded-lg bg-ghost px-4 py-2 text-sm font-medium text-ink" onClick={() => void save()}>
          Save
        </button>
        {saved && <span className="text-sm text-live">Saved</span>}
      </div>

      <p className="text-xs text-mist">Discovery: {state.transport.protocol}</p>
    </div>
  );
}
