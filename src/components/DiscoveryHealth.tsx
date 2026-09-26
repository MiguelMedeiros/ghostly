import type { DiscoveryStatus, RelayHealth } from "@ghostly/core";

/** A relay by its host, as people know it: `pkarr.pubky.org`, not `https://pkarr.pubky.org`. */
function hostOf(relay: string): string {
  try { return new URL(relay).host; } catch { return relay; }
}

const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateText(health: RelayHealth): string {
  if (health.state === "ok") return "ok";
  const until = health.until ? ` until ${at(health.until)}` : "";
  return health.state === "throttled" ? `throttled${until}` : `failing${until}`;
}

/**
 * The connection panel's Details, two lines at most: how this app finds its contacts (the DHT directly, or the
 * relay that answered last) and how each Pkarr relay is doing (ok, throttled until, failing until).
 */
export function DiscoveryHealth({ status }: { status: DiscoveryStatus | undefined }) {
  if (!status) return null;
  const path = status.path?.via === "dht" ? "DHT direct" : status.path?.via === "relay" ? `Relay: ${hostOf(status.path.relay)}` : "Not read yet";
  return (
    <dl data-testid="connection-discovery" className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5">
      <dt>Discovery</dt>
      <dd data-testid="connection-discovery-path" className="min-w-0 break-words text-text-primary">{path}</dd>
      {status.relays.length > 0 && <>
        <dt>Relays</dt>
        <dd className="min-w-0">
          <ul>
            {status.relays.map((health) => (
              <li key={health.relay} data-testid="connection-relay" data-relay={hostOf(health.relay)} data-state={health.state}
                title={health.reason} className="break-words">
                <span className="text-text-primary">{hostOf(health.relay)}</span>{" "}
                <span className={health.state === "failing" ? "text-danger" : health.state === "throttled" ? "text-text-secondary" : ""}>{stateText(health)}</span>
              </li>
            ))}
          </ul>
        </dd>
      </>}
    </dl>
  );
}
