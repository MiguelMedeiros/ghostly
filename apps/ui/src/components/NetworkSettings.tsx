import { useEffect, useRef, useState } from "react";
import { irohRelayUrl, normalizeRelayUrl, relayUrlProblem } from "@ghostly/core";
import { iceServerProblem } from "@ghostly/browser/shared/ice";
import { hyperdhtRelayProblem } from "@ghostly/browser/shared/hyperdhtRelay";
import { pushRelayProblem } from "@ghostly/browser/shared/pushRelay";
import { usePlatformValue } from "../hooks/useServicesPlatform";
import { servicesPlatform } from "../lib/platform";
import { useI18n } from "../contexts/I18nContext";
import { Block, Field, FieldGrid, Row, Section } from "./layout";
import { Switch } from "./wallet/ui";
import { problemLine } from "../lib/problemText";
import { errorText, rawError } from "../lib/errorText";
import { clockOffTexts } from "../lib/clockOff";
import { exactText } from "../lib/exactText";
import { fillNames } from "../lib/fillNodes";
import { FieldError } from "./ui/FieldError";

/** Protocol names the transport line keeps as they are, each its own `<bdi>` (Latin inside an Arabic sentence). */
const PROTOCOL_NAMES = { dht: "Mainline DHT (BEP44)", pkarr: "Pkarr" };

/** The fields a refusal can be about, by their element ids, in page order: the first one refused gets the focus. */
const FIELDS = {
  relays: "network-relays", iroh: "network-iroh-relays", hyperdht: "network-hyperdht-relay", push: "network-push-relay",
  turnUrl: "network-turn-url", turnUsername: "network-turn-username", turnCredential: "network-turn-credential",
} as const;
type FieldName = keyof typeof FIELDS;
/** The TURN server's block, which a link to Settings can name to open Network at it (the call note's). */
export const TURN_FIELD = "network-turn";
/** What is wrong with each field, said in the page's language. */
type Problems = Partial<Record<FieldName, string>>;

/** The TURN field an `iceServerProblem` is about: the missing username or credential, else the address. */
function turnField(problem: string, server: { username?: string; credential?: string }): FieldName {
  if (!problem.startsWith("A TURN server needs")) return "turnUrl";
  return server.username?.trim() ? "turnCredential" : "turnUsername";
}

/**
 * The field a refusal of the engine on Save is about (packages/browser/src/engine/node.ts `updateSettings`), or none:
 * an empty Pkarr list, an Iroh relay (named in the message as typed), or the TURN server Hide my IP still needs.
 */
function refusedField(message: string, irohRelays: readonly string[]): FieldName | undefined {
  if (/^Enter at least one relay address/.test(message)) return "relays";
  if (/Iroh relays$/.test(message)) return "iroh";
  const address = /: (\S+)$/.exec(message)?.[1];
  if (address && irohRelays.includes(address)) return "iroh";
  if (/needs a TURN server/.test(message)) return "turnUrl";
  return undefined;
}

/**
 * Settings section for how this client reaches Pkarr and its peers: the Pkarr relays, an optional TURN server,
 * and the optional HyperDHT relay that lets paired chats use HyperDHT from a browser. A browser reads and
 * writes through the relays; the Desktop reads the DHT directly, writes to the relays too (contacts on the web
 * read only relays), and reads from them only when "Also use Pkarr relays" is on.
 */
export function NetworkSettings() {
  const { t, language } = useI18n();
  const platform = servicesPlatform;
  // Drawn again when the network's settings change by content, not on every state of the engine.
  const network = usePlatformValue(() => platform?.getNetwork() ?? null);
  const [relays, setRelays] = useState("");
  const [turn, setTurn] = useState({ urls: "", username: "", credential: "" });
  const [iroh, setIroh] = useState("");
  const [hyperdhtRelay, setHyperdhtRelay] = useState("");
  const [pushRelay, setPushRelay] = useState("");
  // What was last saved: "Saved" stays up while the form still shows it, instead of flashing past while
  // the engine is busy (a save can take seconds while the wallets start).
  const [savedAs, setSavedAs] = useState<string | null>(null);
  // A refusal about no field (the read switch, an engine error this page cannot place), said by Save.
  const [error, setError] = useState("");
  // Refusals about a field, each said under its field, which carries aria-invalid and points at it.
  const [problems, setProblems] = useState<Problems>({});
  const focusFirst = useRef(false);
  const [switching, setSwitching] = useState(false);
  const loaded = network !== null;

  useEffect(() => {
    if (!network) return;
    setRelays(network.relays.join("\n"));
    setTurn({ urls: network.turn?.urls ?? "", username: network.turn?.username ?? "", credential: network.turn?.credential ?? "" });
    setIroh((network.iroh?.relays.length ? network.iroh.relays : network.iroh?.defaultRelays ?? []).join("\n"));
    setHyperdhtRelay(network.hyperdhtRelay);
    setPushRelay(network.pushRelay ?? "");
    // Load once; afterwards the fields belong to the user until they save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // After a refused Save the focus goes to the first field refused, whose error is read with it (aria-describedby).
  useEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    const first = (Object.keys(FIELDS) as FieldName[]).find((name) => problems[name]);
    if (first) document.getElementById(FIELDS[first])?.focus();
  }, [problems]);

  if (!platform || !network) return null;
  const current = JSON.stringify({ relays, turn, iroh, hyperdhtRelay, pushRelay });
  const saved = savedAs === current;
  // A TURN server restored from a backup comes without its credential (backups leave it out): calls skip it until then.
  const credentialGone = !!network.turn?.urls && !network.turn.credential && !turn.credential;
  const direct = network.readRelays !== undefined;
  // Hide my IP from contacts: this app reads and writes through the relays alone, whatever the switch below says.
  const relayOnly = direct && network.relayOnly === true;
  // How this app reaches the DHT now: with Hide my IP on, the Desktop's DHT node is closed and it goes through the relays.
  const reaches = relayOnly ? "relays" : network.kind;

  const refuse = (refused: Problems) => { focusFirst.current = true; setProblems(refused); };
  // An edit of a refused field takes its error away; the others stay until the next Save.
  const edited = (...names: FieldName[]) => {
    if (names.some((name) => problems[name])) setProblems((now) => Object.fromEntries(Object.entries(now).filter(([name]) => !names.includes(name as FieldName))));
  };
  // The Desktop runs HyperDHT itself and ignores the relay, except while "Hide my IP from contacts" is on: its
  // HyperDHT then goes through the relay, as a browser's does.
  const relaysHyperdht = !direct || network.relayOnly === true;

  const save = async () => {
    setError("");
    setProblems({});
    setSavedAs(null);
    const server = turn.urls.trim() ? { ...turn, urls: turn.urls.trim() } : null;
    // Checked here as well as in the engine, so the person sees why before anything changes: every field at once.
    const relay = relaysHyperdht ? hyperdhtRelay.trim() : "";
    const push = pushRelay.trim();
    // The engine keeps only the Pkarr relays it can read and drops the rest unsaid: a typo next to working relays is
    // named instead (with nothing usable at all, the engine's own "Enter at least one relay address" says it).
    const relayList = relays.split(/\s+/).filter(Boolean);
    const badRelayLine = relayList.some(normalizeRelayUrl) ? relays.split("\n").find((line) => !line.trim().split(/\s+/).filter(Boolean).every(normalizeRelayUrl)) : undefined;
    const refused: Problems = {};
    const relaysProblem = badRelayLine !== undefined ? relayUrlProblem(badRelayLine) : null;
    if (relaysProblem) refused.relays = errorText(relaysProblem, t);
    const relayProblem = relay ? hyperdhtRelayProblem(relay) : null;
    if (relayProblem) refused.hyperdht = errorText(relayProblem, t);
    const pushProblem = push ? pushRelayProblem(push) : null;
    if (pushProblem) refused.push = errorText(pushProblem, t);
    const serverProblem = server ? iceServerProblem(server) : null;
    if (server && serverProblem) refused[turnField(serverProblem, server)] = errorText(serverProblem, t);
    if (Object.keys(refused).length) { refuse(refused); return; }
    const irohRelays = iroh.split(/\s+/).filter(Boolean);
    try {
      // The defaults are stored as "none chosen", so a later change of the defaults reaches this profile.
      // Either spelling of a default (with or without the trailing dot of a full domain name) is that default.
      const defaults = network.iroh && JSON.stringify(irohRelays.map(url => irohRelayUrl(url))) === JSON.stringify(network.iroh.defaultRelays.map(url => irohRelayUrl(url)));
      await platform.setNetwork({ relays: relayList, turn: server, ...(network.iroh ? { irohRelays: defaults ? [] : irohRelays } : {}), ...(relaysHyperdht ? { hyperdhtRelay: relay } : {}), pushRelay: push });
    } catch (e) {
      const field = refusedField(rawError(e), irohRelays);
      if (field) refuse({ [field]: problemLine(e, t) }); else setError(problemLine(e, t));
      return;
    }
    setSavedAs(current);
  };

  // On at once, like the other switches of Settings; the relay list as saved goes with it, not unsaved edits.
  const readRelays = async (on: boolean) => {
    setError("");
    setSwitching(true);
    try { await platform.setNetwork({ relays: network.relays, readRelays: on }); }
    catch (e) { setError(problemLine(e, t)); }
    finally { setSwitching(false); }
  };
  // The same, for "Hide my IP from contacts": the TURN server as saved is the one it needs (the engine says so if none).
  const hideMyIp = async (on: boolean) => {
    setError("");
    setSwitching(true);
    try { await platform.setNetwork({ relays: network.relays, relayOnly: on }); }
    catch (e) { setError(problemLine(e, t)); }
    finally { setSwitching(false); }
  };

  // Addresses read left to right in every language (in Arabic a wrapped relay's trailing "/" would start the next line); labels and hints follow the page.
  const field =
    "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg border border-field-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent transition-colors aria-invalid:border-danger aria-invalid:focus:ring-danger";
  // A refused field: its border says so, and it names its error to assistive technology.
  const invalid = (name: FieldName) => problems[name] ? { "aria-invalid": true, "aria-describedby": `${FIELDS[name]}-error` } : {};
  const problemUnder = (name: FieldName) => <FieldError id={`${FIELDS[name]}-error`} testId="network-error">{problems[name]}</FieldError>;
  const reset = "tap-target min-h-8 text-xs text-text-muted hover:text-accent transition-colors cursor-pointer";

  return (
    <Section title={t("network.title")}>
      {network.clockOffMs !== undefined && <Row label={t("connection.clockOff.title")} {...clockOffTexts(t, network.clockOffMs, language)} testId="network-clock-off" />}
      {network.directBlocked && <Row label={t("connection.directBlocked.title")} hint={t("connection.directBlocked.hint")} info={t("connection.directBlocked.info")} testId="network-direct-blocked" />}
      {direct && <Row label={t("network.readRelays")} hint={t(relayOnly ? "network.readRelaysRelayOnly" : "network.readRelaysHint")} info={t("network.readRelaysInfo")} testId="network-read-relays-row">
        <Switch label={t("network.readRelays")} checked={network.readRelays === true || relayOnly} disabled={relayOnly} busy={switching} onChange={(on) => void readRelays(on)} testId="network-read-relays" />
      </Row>}
      <Field testId="network-relays-field" label={t("network.relays")} htmlFor="network-relays" hint={t("network.relaysHint")} info={t(direct ? "network.relaysInfoDirect" : "network.relaysInfoWeb")}
        trailing={<button onClick={() => setRelays(network.defaultRelays.join("\n"))} aria-label={t("network.resetRelays")} className={reset}>{t("network.reset")}</button>}>
        <textarea id={FIELDS.relays} value={relays} onChange={(e) => { setRelays(e.target.value); edited("relays"); }} rows={2} {...exactText} dir="ltr" data-testid="network-relays"
          {...invalid("relays")} className={`${field} font-mono text-sm resize-y`} />
        {problemUnder("relays")}
      </Field>

      {network.iroh && <Field testId="network-iroh-field" label={t("network.iroh")} htmlFor="network-iroh-relays" hint={t("network.irohHint")} info={t(direct ? "network.irohInfoDirect" : "network.irohInfo")}
        trailing={<button onClick={() => setIroh(network.iroh!.defaultRelays.join("\n"))} aria-label={t("network.resetIroh")} className={reset}>{t("network.reset")}</button>}>
        <textarea id={FIELDS.iroh} value={iroh} onChange={(e) => { setIroh(e.target.value); edited("iroh"); }} rows={2} {...exactText} dir="ltr" data-testid="network-iroh-relays"
          {...invalid("iroh")} className={`${field} font-mono text-sm resize-y`} />
        {problemUnder("iroh")}
      </Field>}

      {/* The Desktop (the DHT reached directly) runs HyperDHT itself and ignores the relay: not offered, and left as saved,
          unless "Hide my IP from contacts" is on (`relaysHyperdht`). */}
      {relaysHyperdht && <Field label={t("network.hyperdht")} htmlFor="network-hyperdht-relay" hint={t("network.hyperdhtHint")} info={t("network.hyperdhtInfo")}>
        <input id={FIELDS.hyperdht} value={hyperdhtRelay} onChange={(e) => { setHyperdhtRelay(e.target.value); edited("hyperdht"); }} placeholder="wss://relay.example.org"
          {...exactText} dir="ltr" data-testid="network-hyperdht-relay" {...invalid("hyperdht")} className={`${field} font-mono text-sm`} />
        {problemUnder("hyperdht")}
      </Field>}

      <Field label={t("network.pushRelay")} htmlFor="network-push-relay" hint={t("network.pushRelayHint")} info={t("network.pushRelayInfo")}>
        <input id={FIELDS.push} value={pushRelay} onChange={(e) => { setPushRelay(e.target.value); edited("push"); }} placeholder="https://push-relay.example.org"
          {...exactText} dir="ltr" data-testid="network-push-relay" {...invalid("push")} className={`${field} font-mono text-sm`} />
        {problemUnder("push")}
        {/* The saved relay answered the last wake-up, but not as a push relay (a web page, its own refusal): said until it forwards one. */}
        {network.pushRelayRefused && pushRelay.trim() === network.pushRelay && <div data-testid="network-push-relay-refused" className="mt-1 text-xs text-warn-ink">
          <p>{t("network.pushRelayRefused", { http: String(network.pushRelayRefused.http) })}</p>
          {network.pushRelayRefused.text && <p data-testid="network-push-relay-said">{fillNames(t("network.pushRelayRefusedSaid"), { text: network.pushRelayRefused.text })}</p>}
        </div>}
      </Field>

      {/* With Hide my IP from contacts on (every client), every connection to a contact goes through it: not optional. */}
      <Field id={TURN_FIELD} testId="network-turn-field" label={t("network.turn")} htmlFor="network-turn-url"
        hint={t(credentialGone ? "network.turnCredentialAgain" : network.relayOnly === true ? "network.turnHintRelayOnly" : "network.turnHint")} info={t("network.turnInfo")}>
        <input id={FIELDS.turnUrl} aria-label={t("network.turnUrl")} value={turn.urls} onChange={(e) => { setTurn({ ...turn, urls: e.target.value }); edited("turnUrl"); }}
          placeholder="turn:turn.example.org:3478" {...exactText} dir="ltr" {...invalid("turnUrl")} className={`${field} font-mono text-sm`} />
        {problemUnder("turnUrl")}
        <FieldGrid>
          <input id={FIELDS.turnUsername} aria-label={t("network.turnUsername")} value={turn.username} onChange={(e) => { setTurn({ ...turn, username: e.target.value }); edited("turnUsername"); }}
            placeholder={t("network.username")} {...exactText} dir="ltr" {...invalid("turnUsername")} className={field} />
          <input id={FIELDS.turnCredential} aria-label={t("network.turnCredential")} type="password" value={turn.credential} onChange={(e) => { setTurn({ ...turn, credential: e.target.value }); edited("turnCredential"); }}
            placeholder={t("network.credential")} {...invalid("turnCredential")} className={field} />
        </FieldGrid>
        {problemUnder("turnUsername")}
        {problemUnder("turnCredential")}
      </Field>

      <Row label={t("network.relayOnly")} hint={t("network.relayOnlyHint")} info={t("network.relayOnlyInfo")} testId="network-relay-only-row">
        <Switch label={t("network.relayOnly")} checked={network.relayOnly === true} busy={switching} onChange={(on) => void hideMyIp(on)} testId="network-relay-only" />
      </Row>

      <Block>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            onClick={() => void save()}
            data-testid="network-save"
            className="tap-target px-4 py-2 min-h-10 bg-accent text-on-accent rounded-lg text-sm font-bold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            {t("common.save")}
          </button>
          {saved && <span role="status" data-testid="network-saved" className="text-accent text-sm">{t("network.saved")}</span>}
          {error && <span role="alert" data-testid="network-error" className="text-danger text-sm min-w-0 break-words">{error}</span>}
          <span data-testid="network-protocol" data-kind={reaches} className="text-text-muted text-xs ms-auto min-w-0">{fillNames(t(reaches === "direct" ? "network.protocolDirect" : "network.protocolRelays"), PROTOCOL_NAMES)}</span>
        </div>
      </Block>
    </Section>
  );
}
