import { useEffect, useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

/** Settings section for clients that reach Pkarr through relays: which relays, and an optional TURN server. */
export function NetworkSettings() {
  const platform = useServicesPlatform();
  const network = platform?.getNetwork() ?? null;
  const [relays, setRelays] = useState("");
  const [turn, setTurn] = useState({ urls: "", username: "", credential: "" });
  const [saved, setSaved] = useState(false);
  const loaded = network !== null;

  useEffect(() => {
    if (!network) return;
    setRelays(network.relays.join("\n"));
    setTurn({ urls: network.turn?.urls ?? "", username: network.turn?.username ?? "", credential: network.turn?.credential ?? "" });
    // Load once; afterwards the fields belong to the user until they save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!platform || !network) return null;

  const save = async () => {
    await platform.setNetwork({
      relays: relays.split(/\s+/).filter(Boolean),
      turn: turn.urls.trim() ? { ...turn, urls: turn.urls.trim() } : null,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const field =
    "w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition-colors";

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">Network</h2>

      <div className="bg-surface rounded-xl p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-text-primary block font-medium">Pkarr relays</label>
          <p className="text-text-muted text-xs">
            Browsers cannot reach the Mainline DHT directly; relays do it for them. They only see signed, encrypted
            packets and never carry your messages, calls or services. One per line, all of them are used.
          </p>
          <textarea
            value={relays}
            onChange={(e) => setRelays(e.target.value)}
            rows={3}
            data-testid="network-relays"
            className={`${field} font-mono text-sm resize-y`}
          />
          <button
            onClick={() => setRelays(network.defaultRelays.join("\n"))}
            className="text-xs text-text-muted hover:text-accent transition-colors cursor-pointer"
          >
            Reset to defaults
          </button>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <label className="text-text-primary block font-medium">TURN server (optional)</label>
          <p className="text-text-muted text-xs">
            Only used when a direct connection is impossible. It forwards encrypted WebRTC packets; it is
            connectivity infrastructure, not a Ghostly server.
          </p>
          <input
            value={turn.urls}
            onChange={(e) => setTurn({ ...turn, urls: e.target.value })}
            placeholder="turn:turn.example.org:3478"
            className={`${field} font-mono text-sm`}
          />
          <div className="flex gap-2">
            <input
              value={turn.username}
              onChange={(e) => setTurn({ ...turn, username: e.target.value })}
              placeholder="Username"
              className={field}
            />
            <input
              type="password"
              value={turn.credential}
              onChange={(e) => setTurn({ ...turn, credential: e.target.value })}
              placeholder="Credential"
              className={field}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            data-testid="network-save"
            className="px-4 py-2 bg-accent text-[#111b21] rounded-lg text-sm font-bold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            Save
          </button>
          {saved && <span className="text-accent text-sm">Saved</span>}
          <span data-testid="network-protocol" className="text-text-muted text-xs ml-auto">{network.protocol}</span>
        </div>
      </div>
    </section>
  );
}
