import { useEffect, useState } from "react";
import { PeerView } from "./PeerView";
import { ServicesPanel } from "./ServicesPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Dot, ghostName, shortKey } from "./bits";
import { useEngine } from "./useEngine";

type Selection = { kind: "peer"; linkId: string } | { kind: "settings" } | null;

export function App() {
  const engine = useEngine();
  const { state, call } = engine;
  const [selection, setSelection] = useState<Selection>(null);
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selectedLinkId = selection?.kind === "peer" ? selection.linkId : null;
  const ready = state !== null;
  useEffect(() => {
    if (ready) void call("setActiveLink", { linkId: selectedLinkId }).catch(() => {});
  }, [call, selectedLinkId, ready]);

  if (!state) {
    return <div className="grid h-full place-items-center text-mist">Waking the ghost…</div>;
  }

  const online = state.settings.online;
  const selectedLink = state.links.find((l) => l.id === selectedLinkId);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl">
      <aside className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-r border-edge p-5">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-[0.3em]">👻 GHOSTLY</h1>
          <button className="text-sm text-mist hover:text-white" onClick={() => setSelection({ kind: "settings" })}>
            Settings
          </button>
        </header>

        <section>
          <h2 className="mb-2 text-xs uppercase tracking-widest text-mist">Status</h2>
          <button
            data-testid="online-toggle"
            className="flex w-full items-center justify-between rounded-lg border border-edge bg-panel px-3 py-2 text-left"
            onClick={() => run(() => call("updateSettings", { settings: { online: !online } }))}
          >
            <span className="flex items-center gap-2">
              <Dot on={online} /> {online ? "Online" : "Offline"}
            </span>
            <span className="text-xs text-mist">{online ? "Go offline" : "Go online"}</span>
          </button>
          <p className="mt-2 text-xs text-mist">
            {online
              ? "Your peers can reach you and what you share. Close the browser and it is all gone."
              : "You are invisible. Nothing you share is reachable."}
          </p>
        </section>

        <ServicesPanel engine={engine} />

        <section>
          <h2 className="mb-2 text-xs uppercase tracking-widest text-mist">Peers</h2>
          <ul className="flex flex-col gap-1">
            {state.links.map((link) => (
              <li key={link.id}>
                <button
                  data-testid="peer-item"
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-panel ${
                    link.id === selectedLinkId ? "bg-panel" : ""
                  }`}
                  onClick={() => setSelection({ kind: "peer", linkId: link.id })}
                >
                  <Dot on={link.peerOnline} />
                  <span className="min-w-0 flex-1 truncate">
                    {link.label ?? link.peerNick ?? ghostName(link.peerPubKeyZ32)}
                  </span>
                  <span className="font-mono text-xs text-mist">{shortKey(link.peerPubKeyZ32)}</span>
                </button>
              </li>
            ))}
            {state.links.length === 0 && <li className="text-sm text-mist">No peers yet.</li>}
          </ul>

          <div className="mt-3 flex flex-col gap-2">
            <button
              data-testid="create-link"
              className="rounded-lg bg-ghost px-3 py-2 text-sm font-medium text-ink hover:brightness-110"
              onClick={() =>
                run(async () => {
                  const { linkId } = await call("createLink");
                  setSelection({ kind: "peer", linkId });
                })
              }
            >
              + New peer invite
            </button>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const { linkId } = await call("joinLink", { inviteCode: invite });
                  setInvite("");
                  setSelection({ kind: "peer", linkId });
                });
              }}
            >
              <input
                data-testid="invite-input"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-ghost"
                placeholder="Paste an invite"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
              />
              <button data-testid="join-link" className="rounded-lg border border-edge px-3 py-2 text-sm hover:bg-panel" disabled={!invite.trim()}>
                Join
              </button>
            </form>
          </div>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </section>
      </aside>

      <main className="min-w-0 flex-1">
        {selection?.kind === "settings" ? (
          <SettingsPanel engine={engine} />
        ) : selectedLink ? (
          <PeerView key={selectedLink.id} engine={engine} link={selectedLink} onRemoved={() => setSelection(null)} />
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-mist">
            <div>
              <div className="text-5xl">👻</div>
              <p className="mt-4 max-w-sm">
                Your services exist while you are online. Invite a peer, share a local app, and it is reachable, peer
                to peer, until you leave.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
