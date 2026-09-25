import { useEffect, useState } from "react";
import { iceServerProblem } from "@ghostly/browser/shared/ice";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { Block, FieldGrid, Section } from "./layout";

/** Settings section for clients that reach Pkarr through relays: which relays, and an optional TURN server. */
export function NetworkSettings() {
  const platform = useServicesPlatform();
  const network = platform?.getNetwork() ?? null;
  const [relays, setRelays] = useState("");
  const [turn, setTurn] = useState({ urls: "", username: "", credential: "" });
  const [iroh, setIroh] = useState("");
  // What was last saved: "Saved" stays up while the form still shows it, instead of flashing past while
  // the engine is busy (a save can take seconds while the wallets start).
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loaded = network !== null;

  useEffect(() => {
    if (!network) return;
    setRelays(network.relays.join("\n"));
    setTurn({ urls: network.turn?.urls ?? "", username: network.turn?.username ?? "", credential: network.turn?.credential ?? "" });
    setIroh((network.iroh?.relays.length ? network.iroh.relays : network.iroh?.defaultRelays ?? []).join("\n"));
    // Load once; afterwards the fields belong to the user until they save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!platform || !network) return null;
  const current = JSON.stringify({ relays, turn, iroh });
  const saved = savedAs === current;

  const save = async () => {
    setError("");
    setSavedAs(null);
    const server = turn.urls.trim() ? { ...turn, urls: turn.urls.trim() } : null;
    // Checked here as well as in the engine, so the person sees why before anything changes.
    const problem = server ? iceServerProblem(server) : null;
    if (problem) { setError(problem); return; }
    try {
      const irohRelays = iroh.split(/\s+/).filter(Boolean);
      // The defaults are stored as "none chosen", so a later change of the defaults reaches this profile.
      const defaults = network.iroh && JSON.stringify(irohRelays) === JSON.stringify(network.iroh.defaultRelays);
      await platform.setNetwork({ relays: relays.split(/\s+/).filter(Boolean), turn: server, ...(network.iroh ? { irohRelays: defaults ? [] : irohRelays } : {}) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    setSavedAs(current);
  };

  const field =
    "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent transition-colors";

  return (
    <Section title="Network">
      <Block>
        <div>
          <label htmlFor="network-relays" className="text-text-primary text-sm block">Pkarr relays</label>
          <p className="text-text-muted text-xs mt-0.5">
            Browsers cannot reach the Mainline DHT directly; relays do it for them. They only see signed, encrypted
            packets and never carry your messages, calls or services. One per line, all of them are used.
          </p>
        </div>
        <textarea
          id="network-relays"
          value={relays}
          onChange={(e) => setRelays(e.target.value)}
          rows={3}
          spellCheck={false}
          data-testid="network-relays"
          className={`${field} font-mono text-sm resize-y`}
        />
        <button
          onClick={() => setRelays(network.defaultRelays.join("\n"))}
          className="min-h-8 text-xs text-text-muted hover:text-accent transition-colors cursor-pointer"
        >
          Reset to defaults
        </button>
      </Block>

      <Block>
        <div>
          <p className="text-text-primary text-sm">TURN server (optional)</p>
          <p className="text-text-muted text-xs mt-0.5">
            Only used when a direct connection is impossible. It forwards encrypted WebRTC packets; it is
            connectivity infrastructure, not a Ghostly server.
          </p>
        </div>
        <input
          aria-label="TURN server URL"
          value={turn.urls}
          onChange={(e) => setTurn({ ...turn, urls: e.target.value })}
          placeholder="turn:turn.example.org:3478"
          spellCheck={false}
          className={`${field} font-mono text-sm`}
        />
        <FieldGrid>
          <input
            aria-label="TURN username"
            value={turn.username}
            onChange={(e) => setTurn({ ...turn, username: e.target.value })}
            placeholder="Username"
            className={field}
          />
          <input
            aria-label="TURN credential"
            type="password"
            value={turn.credential}
            onChange={(e) => setTurn({ ...turn, credential: e.target.value })}
            placeholder="Credential"
            className={field}
          />
        </FieldGrid>
      </Block>

      {network.iroh && <Block>
        <div>
          <label htmlFor="network-iroh-relays" className="text-text-primary text-sm block">Iroh relays</label>
          <p className="text-text-muted text-xs mt-0.5">
            A browser cannot send the UDP packets Iroh uses, so Iroh chats here always go through a relay: used
            only when WebRTC cannot connect. The relay sees which devices talk and when, never what they say
            (the connection is encrypted end to end). One per line, at most four.
          </p>
        </div>
        <textarea
          id="network-iroh-relays"
          value={iroh}
          onChange={(e) => setIroh(e.target.value)}
          rows={2}
          spellCheck={false}
          data-testid="network-iroh-relays"
          className={`${field} font-mono text-sm resize-y`}
        />
        <button
          onClick={() => setIroh(network.iroh!.defaultRelays.join("\n"))}
          aria-label="Reset Iroh relays to defaults"
          className="min-h-8 text-xs text-text-muted hover:text-accent transition-colors cursor-pointer"
        >
          Reset to defaults
        </button>
      </Block>}

      <Block>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            onClick={() => void save()}
            data-testid="network-save"
            className="px-4 py-2 min-h-10 bg-accent text-on-accent rounded-lg text-sm font-bold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            Save
          </button>
          {saved && <span role="status" data-testid="network-saved" className="text-accent text-sm">Saved</span>}
          {error && <span role="alert" data-testid="network-error" className="text-danger text-sm min-w-0 break-words">{error}</span>}
          <span data-testid="network-protocol" className="text-text-muted text-xs ml-auto min-w-0">{network.protocol}</span>
        </div>
      </Block>
    </Section>
  );
}
