import { useState } from "react";
import { parseLocalTarget } from "@ghostly/core";
import { Dot } from "./bits";
import type { Engine } from "./useEngine";

/**
 * The user's own services. Nothing is shared unless it is listed here, and
 * Chrome's own permission prompt gates access to the local host first.
 */
export function ServicesPanel({ engine }: { engine: Engine }) {
  const { state, call } = engine;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;

  const add = async () => {
    setError(null);
    try {
      const { origin } = parseLocalTarget(target);
      const url = new URL(origin);
      // Must run inside the click: Chrome only prompts on a user gesture.
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
      if (!granted) throw new Error("Ghostly needs your permission to reach that local address");
      await call("addService", { name, target });
      setName("");
      setTarget("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-xs uppercase tracking-widest text-mist">Services</h2>
      <ul className="flex flex-col gap-2">
        {state.services.map((service) => {
          const shared = service.enabled && state.settings.online;
          return (
            <li key={service.id} data-testid="service-item" className="rounded-lg border border-edge bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{service.name}</span>
                <button
                  className="text-xs text-mist hover:text-red-400"
                  onClick={() => void call("removeService", { serviceId: service.id })}
                >
                  Remove
                </button>
              </div>
              <div className="truncate font-mono text-xs text-mist">{service.target.replace(/^https?:\/\//, "")}</div>
              <div className="mt-2 flex items-center justify-between">
                <span className={`flex items-center gap-2 text-sm ${shared ? "text-live" : "text-mist"}`}>
                  <Dot on={shared} />
                  {shared ? "Shared with your peers" : service.enabled ? "Not reachable (offline)" : "Stopped"}
                </span>
                <button
                  className="rounded border border-edge px-2 py-1 text-xs hover:bg-ink"
                  onClick={() => void call("setServiceEnabled", { serviceId: service.id, enabled: !service.enabled })}
                >
                  {service.enabled ? "Stop" : "Share"}
                </button>
              </div>
              {service.requests > 0 && <div className="mt-1 text-xs text-mist">{service.requests} requests served</div>}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <form
          className="mt-2 flex flex-col gap-2 rounded-lg border border-edge p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            data-testid="service-name"
            className="rounded border border-edge bg-panel px-2 py-1.5 text-sm outline-none focus:border-ghost"
            placeholder="Service name (Atlas)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <input
            data-testid="service-target"
            className="rounded border border-edge bg-panel px-2 py-1.5 font-mono text-sm outline-none focus:border-ghost"
            placeholder="localhost:3400"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <p className="text-xs text-mist">
            Every peer you are linked with will be able to use this app as if they were on this machine. Only this
            address is exposed.
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button data-testid="service-save" className="flex-1 rounded bg-ghost px-3 py-1.5 text-sm font-medium text-ink" disabled={!name.trim() || !target.trim()}>
              Share
            </button>
            <button type="button" className="rounded border border-edge px-3 py-1.5 text-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          data-testid="add-service"
          className="mt-2 w-full rounded-lg border border-dashed border-edge px-3 py-2 text-sm text-mist hover:border-ghost hover:text-white"
          onClick={() => setAdding(true)}
        >
          + Share local service
        </button>
      )}
    </section>
  );
}
