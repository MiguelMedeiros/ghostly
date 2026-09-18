import { useCallback, useEffect, useRef, useState } from "react";
import { UI_PORT, type EngineApi, type EngineEvent, type EngineMethod, type RpcResponse, type RuntimeMessage } from "../shared/rpc";
import type { EngineState, StoredMessage } from "../shared/types";

type Call = <M extends EngineMethod>(
  method: M,
  ...params: Parameters<EngineApi[M]>
) => Promise<Awaited<ReturnType<EngineApi[M]>>>;

export interface Engine {
  state: EngineState | null;
  messages: Record<string, StoredMessage[]>;
  call: Call;
  onCallSignal: (listener: (linkId: string, signal: string) => void) => () => void;
}

/** Connects this page to the peer running in the offscreen document. */
export function useEngine(): Engine {
  const [state, setState] = useState<EngineState | null>(null);
  const [messages, setMessages] = useState<Record<string, StoredMessage[]>>({});
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const pendingRef = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const nextIdRef = useRef(1);
  const callListenersRef = useRef(new Set<(linkId: string, signal: string) => void>());

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      await chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" } satisfies RuntimeMessage);
      if (disposed) return;
      const port = chrome.runtime.connect({ name: UI_PORT });
      portRef.current = port;

      port.onMessage.addListener((message: EngineEvent | RpcResponse) => {
        if (message.kind === "state") setState(message.state);
        else if (message.kind === "messages") setMessages((all) => ({ ...all, [message.linkId]: message.messages }));
        else if (message.kind === "call-signal") {
          for (const listener of callListenersRef.current) listener(message.linkId, message.signal);
        } else if (message.kind === "response") {
          const pending = pendingRef.current.get(message.id);
          pendingRef.current.delete(message.id);
          if (message.error !== undefined) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        portRef.current = null;
        for (const pending of pendingRef.current.values()) pending.reject(new Error("Lost the Ghostly peer"));
        pendingRef.current.clear();
        if (!disposed) retry = setTimeout(connect, 500);
      });
    };
    void connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, []);

  const call = useCallback<Call>((method, ...params) => {
    const port = portRef.current;
    if (!port) return Promise.reject(new Error("Ghostly is starting…"));
    const id = nextIdRef.current++;
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ kind: "request", id, method, params: params[0] });
    });
  }, []);

  const onCallSignal = useCallback<Engine["onCallSignal"]>((listener) => {
    callListenersRef.current.add(listener);
    return () => callListenersRef.current.delete(listener);
  }, []);

  return { state, messages, call, onCallSignal };
}
