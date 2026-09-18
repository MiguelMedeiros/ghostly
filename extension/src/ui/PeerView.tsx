import { useEffect, useRef, useState } from "react";
import type { RuntimeMessage } from "../shared/rpc";
import type { LinkView } from "../shared/types";
import { CopyButton, Dot, ghostName } from "./bits";
import type { Engine } from "./useEngine";

const DATA_LINK_LABEL: Record<LinkView["dataLink"], string> = {
  idle: "Not connected",
  offering: "Calling the peer…",
  answering: "Answering…",
  connecting: "Connecting…",
  open: "Connected peer to peer",
};

export function PeerView({ engine, link, onRemoved }: { engine: Engine; link: LinkView; onRemoved: () => void }) {
  const { call } = engine;
  const messages = engine.messages[link.id] ?? [];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const name = link.label ?? link.peerNick ?? ghostName(link.peerPubKeyZ32);
  const httpServices = (link.peerServices ?? []).filter((s) => s.type === "http");
  const busy = link.dataLink !== "idle" && link.dataLink !== "open";

  const send = async () => {
    const text = draft;
    setDraft("");
    setError(null);
    const result = await call("sendMessage", { linkId: link.id, text }).catch((e: Error) => ({ error: e.message }));
    if (result.error) setError(result.error);
  };

  const open = async (serviceId: string) => {
    setError(null);
    const reply = await chrome.runtime.sendMessage({
      target: "background",
      type: "open-service",
      peerPubKeyZ32: link.peerPubKeyZ32,
      serviceId,
    } satisfies RuntimeMessage);
    if (!reply?.ok) setError(reply?.error ?? "Could not open the service");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate text-xl font-semibold">{name}</h2>
          <button
            className="text-xs text-mist hover:text-red-400"
            onClick={() => {
              if (confirm("Forget this peer and the conversation?")) void call("removeLink", { linkId: link.id }).then(onRemoved);
            }}
          >
            Forget peer
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-xs text-mist">
          <span className="truncate" data-testid="peer-key">{link.peerPubKeyZ32}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="flex items-center gap-2" data-testid="peer-presence">
            <Dot on={link.peerOnline} />
            {link.peerOnline
              ? "Online"
              : link.peerLastSeenAt
                ? `Last seen ${new Date(link.peerLastSeenAt).toLocaleString()}`
                : "Not seen yet"}
          </span>
          <span className="flex items-center gap-2 text-mist" data-testid="datalink-state">
            <Dot on={link.dataLink === "open"} /> {DATA_LINK_LABEL[link.dataLink]}
          </span>
          {link.dataLink === "open" ? (
            <button className="rounded border border-edge px-2 py-1 text-xs" onClick={() => void call("disconnect", { linkId: link.id })}>
              Disconnect
            </button>
          ) : (
            <button
              data-testid="connect"
              className="rounded border border-edge px-2 py-1 text-xs disabled:opacity-50"
              disabled={busy}
              onClick={() => void call("connect", { linkId: link.id })}
            >
              Connect
            </button>
          )}
        </div>

        {link.inviteCode && (
          <div className="mt-4 rounded-lg border border-ghost/40 bg-panel p-3">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>Send this invite to your peer</span>
              <CopyButton text={link.inviteCode} />
            </div>
            <code data-testid="invite-code" className="block break-all text-xs text-mist">{link.inviteCode}</code>
            <p className="mt-2 text-xs text-mist">
              It works in Ghostly Browser and Ghostly Desktop alike. Anyone holding it becomes this peer, so share it
              privately.
            </p>
          </div>
        )}

        <section className="mt-4">
          <h3 className="mb-2 text-xs uppercase tracking-widest text-mist">Services</h3>
          {httpServices.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {httpServices.map((service) => (
                <li key={service.id} data-testid="peer-service" className="flex items-center gap-3 rounded-lg border border-edge bg-panel px-3 py-2">
                  <span>
                    <span className="font-medium">{service.name ?? service.id}</span>
                    <span className="ml-2 text-xs text-mist">http</span>
                  </span>
                  <button
                    data-testid="open-service"
                    className="rounded bg-ghost px-3 py-1 text-sm font-medium text-ink hover:brightness-110"
                    onClick={() => void open(service.id)}
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-mist">
              {link.peerOnline ? "This peer shares no web services right now." : "Services show up while the peer is online."}
            </p>
          )}
        </section>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <ul className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.id}
              data-testid="message"
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                message.sender === "me" ? "self-end bg-ghost text-ink" : "self-start bg-panel"
              }`}
            >
              <div className="whitespace-pre-wrap break-words">{message.text}</div>
              <div className={`mt-1 text-[10px] ${message.sender === "me" ? "text-ink/60" : "text-mist"}`}>
                {new Date(message.timestamp).toLocaleTimeString()} · {message.via === "datalink" ? "WebRTC" : "DHT"}
              </div>
            </li>
          ))}
        </ul>
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t border-edge p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void send();
        }}
      >
        <input
          data-testid="message-input"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 outline-none focus:border-ghost"
          placeholder={link.dataLink === "open" ? "Message (peer to peer)" : "Message (through the DHT, max 500 bytes)"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button data-testid="message-send" className="rounded-lg bg-ghost px-4 py-2 font-medium text-ink disabled:opacity-50" disabled={!draft.trim()}>
          Send
        </button>
      </form>
      {error && <p data-testid="peer-error" className="px-4 pb-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
