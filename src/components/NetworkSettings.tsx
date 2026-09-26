import { useEffect, useState } from "react";
import { iceServerProblem } from "@ghostly/browser/shared/ice";
import { hyperdhtRelayProblem } from "@ghostly/browser/shared/hyperdhtRelay";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Block, Field, FieldGrid, Row, Section } from "./layout";
import { Switch } from "./wallet/ui";

/**
 * Settings section for how this client reaches Pkarr and its peers: the Pkarr relays, an optional TURN server,
 * and the optional HyperDHT relay that lets paired chats use HyperDHT from a browser. A browser reads and
 * writes through the relays; the Desktop reads the DHT directly, writes to the relays too (contacts on the web
 * read only relays), and reads from them only when "Also use Pkarr relays" is on.
 */
export function NetworkSettings() {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const network = platform?.getNetwork() ?? null;
  const [relays, setRelays] = useState("");
  const [turn, setTurn] = useState({ urls: "", username: "", credential: "" });
  const [iroh, setIroh] = useState("");
  const [hyperdhtRelay, setHyperdhtRelay] = useState("");
  // What was last saved: "Saved" stays up while the form still shows it, instead of flashing past while
  // the engine is busy (a save can take seconds while the wallets start).
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const loaded = network !== null;

  useEffect(() => {
    if (!network) return;
    setRelays(network.relays.join("\n"));
    setTurn({ urls: network.turn?.urls ?? "", username: network.turn?.username ?? "", credential: network.turn?.credential ?? "" });
    setIroh((network.iroh?.relays.length ? network.iroh.relays : network.iroh?.defaultRelays ?? []).join("\n"));
    setHyperdhtRelay(network.hyperdhtRelay);
    // Load once; afterwards the fields belong to the user until they save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!platform || !network) return null;
  const current = JSON.stringify({ relays, turn, iroh, hyperdhtRelay });
  const saved = savedAs === current;

  const save = async () => {
    setError("");
    setSavedAs(null);
    const server = turn.urls.trim() ? { ...turn, urls: turn.urls.trim() } : null;
    // Checked here as well as in the engine, so the person sees why before anything changes.
    const relay = hyperdhtRelay.trim();
    const problem = (server ? iceServerProblem(server) : null) ?? (relay ? hyperdhtRelayProblem(relay) : null);
    if (problem) { setError(problem); return; }
    try {
      const irohRelays = iroh.split(/\s+/).filter(Boolean);
      // The defaults are stored as "none chosen", so a later change of the defaults reaches this profile.
      const defaults = network.iroh && JSON.stringify(irohRelays) === JSON.stringify(network.iroh.defaultRelays);
      await platform.setNetwork({ relays: relays.split(/\s+/).filter(Boolean), turn: server, ...(network.iroh ? { irohRelays: defaults ? [] : irohRelays } : {}), hyperdhtRelay: relay });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    setSavedAs(current);
  };

  const direct = network.readRelays !== undefined;
  // On at once, like the other switches of Settings; the relay list as saved goes with it, not unsaved edits.
  const readRelays = async (on: boolean) => {
    setError("");
    setSwitching(true);
    try { await platform.setNetwork({ relays: network.relays, turn: network.turn, readRelays: on }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSwitching(false); }
  };

  const field =
    "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent transition-colors";
  const reset = "min-h-8 text-xs text-text-muted hover:text-accent transition-colors cursor-pointer";

  return (
    <Section title={t("network.title")}>
      {direct && <Row label={t("network.readRelays")} hint={t("network.readRelaysHint")} info={t("network.readRelaysInfo")} testId="network-read-relays-row">
        <Switch label={t("network.readRelays")} checked={network.readRelays === true} disabled={switching} onChange={(on) => void readRelays(on)} testId="network-read-relays" />
      </Row>}
      <Field testId="network-relays-field" label={t("network.relays")} htmlFor="network-relays" hint={t("network.relaysHint")} info={t(direct ? "network.relaysInfoDirect" : "network.relaysInfoWeb")}
        trailing={<button onClick={() => setRelays(network.defaultRelays.join("\n"))} aria-label={t("network.resetRelays")} className={reset}>{t("network.reset")}</button>}>
        <textarea id="network-relays" value={relays} onChange={(e) => setRelays(e.target.value)} rows={2} spellCheck={false} data-testid="network-relays"
          className={`${field} font-mono text-sm resize-y`} />
      </Field>

      {network.iroh && <Field label={t("network.iroh")} htmlFor="network-iroh-relays" hint={t("network.irohHint")} info={t("network.irohInfo")}
        trailing={<button onClick={() => setIroh(network.iroh!.defaultRelays.join("\n"))} aria-label={t("network.resetIroh")} className={reset}>{t("network.reset")}</button>}>
        <textarea id="network-iroh-relays" value={iroh} onChange={(e) => setIroh(e.target.value)} rows={2} spellCheck={false} data-testid="network-iroh-relays"
          className={`${field} font-mono text-sm resize-y`} />
      </Field>}

      <Field label={t("network.hyperdht")} htmlFor="network-hyperdht-relay" hint={t("network.hyperdhtHint")} info={t("network.hyperdhtInfo")}>
        <input id="network-hyperdht-relay" value={hyperdhtRelay} onChange={(e) => setHyperdhtRelay(e.target.value)} placeholder="wss://relay.example.org"
          spellCheck={false} data-testid="network-hyperdht-relay" className={`${field} font-mono text-sm`} />
      </Field>

      <Field label={t("network.turn")} htmlFor="network-turn-url" hint={t("network.turnHint")} info={t("network.turnInfo")}>
        <input id="network-turn-url" aria-label={t("network.turnUrl")} value={turn.urls} onChange={(e) => setTurn({ ...turn, urls: e.target.value })}
          placeholder="turn:turn.example.org:3478" spellCheck={false} className={`${field} font-mono text-sm`} />
        <FieldGrid>
          <input aria-label={t("network.turnUsername")} value={turn.username} onChange={(e) => setTurn({ ...turn, username: e.target.value })}
            placeholder={t("network.username")} className={field} />
          <input aria-label={t("network.turnCredential")} type="password" value={turn.credential} onChange={(e) => setTurn({ ...turn, credential: e.target.value })}
            placeholder={t("network.credential")} className={field} />
        </FieldGrid>
      </Field>

      <Block>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            onClick={() => void save()}
            data-testid="network-save"
            className="px-4 py-2 min-h-10 bg-accent text-on-accent rounded-lg text-sm font-bold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            {t("common.save")}
          </button>
          {saved && <span role="status" data-testid="network-saved" className="text-accent text-sm">{t("network.saved")}</span>}
          {error && <span role="alert" data-testid="network-error" className="text-danger text-sm min-w-0 break-words">{error}</span>}
          <span data-testid="network-protocol" className="text-text-muted text-xs ml-auto min-w-0">{network.protocol}</span>
        </div>
      </Block>
    </Section>
  );
}
