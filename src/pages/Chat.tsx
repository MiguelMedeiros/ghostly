import { useEffect, useRef, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { TechPanel } from "../components/TechPanel";
import { markSessionAsRead, generateSessionId } from "../lib/storage";
import type { ChatParams } from "../lib/types";

export function Chat() {
  const { "*": splat } = useParams();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [confirmBurn, setConfirmBurn] = useState(false);

  const params: ChatParams | null = (() => {
    if (!splat) return null;
    const parts = splat.split("/");
    if (parts.length !== 3) return null;
    return {
      seedB64: parts[0],
      peerPubKeyB64: parts[1],
      encKeyB64: parts[2],
    };
  })();

  const {
    messages,
    status,
    lastSync,
    isSending,
    sendMessage,
    burn,
    isBurned,
    techInfo,
    peerAck,
  } = useChat(params);

  useEffect(() => {
    setConfirmBurn(false);
  }, [splat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (params) {
      const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
      markSessionAsRead(sessionId);
    }
  }, [params, messages.length]);

  if (!params) {
    return <Navigate to="/" replace />;
  }

  const handleBurn = () => {
    if (confirmBurn) {
      burn();
      setConfirmBurn(false);
    } else {
      setConfirmBurn(true);
    }
  };

  const statusConfig = {
    connecting: { color: "bg-yellow-500", label: "connecting" },
    online: { color: "bg-accent", label: "online" },
    offline: { color: "bg-gray-500", label: "offline" },
    error: { color: "bg-danger", label: "error" },
  };
  const { color: statusColor, label: statusLabel } = statusConfig[status];

  const syncText = lastSync
    ? new Date(lastSync).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const peerLabel = params.peerPubKeyB64.slice(0, 16) + "...";

  return (
    <div className="flex-1 flex flex-col h-full bg-chat-bg">
      {/* Chat Header */}
      <div className="h-14 flex items-center justify-between px-4 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-surface-hover flex items-center justify-center">
            <span className="text-text-muted text-sm">
              {peerLabel.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <p className="text-text-primary text-[15px] font-normal m-0 leading-tight">
              {peerLabel}
            </p>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${statusColor} ${status === "connecting" ? "animate-pulse-dot" : ""}`}
              />
              <span className="text-text-muted text-xs">
                {statusLabel}
                {syncText && ` · ${syncText}`}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {confirmBurn ? (
            <div className="flex items-center gap-2 animate-fade-in">
              <span className="text-danger text-xs">Burn?</span>
              <button
                onClick={handleBurn}
                className="px-2.5 py-1 bg-danger/20 text-danger border border-danger/30 rounded text-xs font-bold hover:bg-danger/30 transition-colors cursor-pointer"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmBurn(false)}
                className="px-2.5 py-1 bg-surface-hover text-text-muted border border-border rounded text-xs font-bold hover:text-text-secondary transition-colors cursor-pointer"
              >
                No
              </button>
            </div>
          ) : (
            !isBurned && (
              <button
                onClick={handleBurn}
                className="p-2 text-text-secondary hover:text-danger rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
                title="Burn chat"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                </svg>
              </button>
            )
          )}
        </div>
      </div>

      {/* Tech Panel */}
      <TechPanel
        techInfo={techInfo}
        status={status}
        lastSync={lastSync}
        messageCount={messages.length}
      />

      {/* Burn Banner */}
      {isBurned && (
        <div className="bg-danger/10 border-b border-danger/20 px-4 py-2 text-center shrink-0">
          <span className="text-danger text-xs font-bold">
            Chat burned — messages will expire from the DHT
          </span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto chat-wallpaper">
        <div className="max-w-3xl mx-auto py-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center min-h-[200px]">
              <div className="bg-surface-alt/90 rounded-lg px-4 py-2 text-center">
                <p className="text-text-muted text-xs">
                  Send a message or wait for your contact
                </p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} peerAck={peerAck} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <MessageInput onSend={sendMessage} disabled={isBurned || isSending} />
    </div>
  );
}
