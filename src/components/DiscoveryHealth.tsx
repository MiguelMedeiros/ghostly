import type { DiscoveryStatus, RelayHealth } from "@ghostly/core";
import { useI18n, type Translate } from "../contexts/I18nContext";

/** A relay by its host, as people know it: `pkarr.pubky.org`, not `https://pkarr.pubky.org`. */
function hostOf(relay: string): string {
  try { return new URL(relay).host; } catch { return relay; }
}

const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateText(health: RelayHealth, t: Translate): string {
  if (health.state === "ok") return t("connection.discovery.ok");
  const throttled = health.state === "throttled";
  if (!health.until) return throttled ? t("connection.discovery.throttled") : t("connection.discovery.failing");
  return t(throttled ? "connection.discovery.throttledUntil" : "connection.discovery.failingUntil", { time: at(health.until) });
}

/**
 * The connection panel's Details, two lines at most: how this app finds its contacts (the DHT directly, or the
 * relay that answered last) and how each Pkarr relay is doing (ok, throttled until, failing until).
 */
export function DiscoveryHealth({ status }: { status: DiscoveryStatus | undefined }) {
  const { t } = useI18n();
  if (!status) return null;
  const path = status.path?.via === "dht" ? t("connection.discovery.dhtDirect") : status.path?.via === "relay" ? t("connection.discovery.relay", { host: hostOf(status.path.relay) }) : t("connection.discovery.notRead");
  return (
    <dl data-testid="connection-discovery" className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5">
      <dt>{t("connection.discovery.title")}</dt>
      <dd data-testid="connection-discovery-path" className="min-w-0 break-words text-text-primary">{path}</dd>
      {status.relays.length > 0 && <>
        <dt>{t("connection.discovery.relays")}</dt>
        <dd className="min-w-0">
          <ul>
            {status.relays.map((health) => (
              <li key={health.relay} data-testid="connection-relay" data-relay={hostOf(health.relay)} data-state={health.state}
                title={health.reason} className="break-words">
                <span className="text-text-primary">{hostOf(health.relay)}</span>{" "}
                <span className={health.state === "failing" ? "text-danger" : health.state === "throttled" ? "text-text-secondary" : ""}>{stateText(health, t)}</span>
              </li>
            ))}
          </ul>
        </dd>
      </>}
    </dl>
  );
}
