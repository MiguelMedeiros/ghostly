import type { EngineState, Settings, StoredMessage } from "./types";

/** UI → engine calls, carried over a `chrome.runtime` port named `ui`. */
export interface EngineApi {
  createLink(): { linkId: string; inviteCode: string };
  joinLink(params: { inviteCode: string }): { linkId: string };
  removeLink(params: { linkId: string }): void;
  renameLink(params: { linkId: string; label: string }): void;
  setActiveLink(params: { linkId: string | null }): void;
  sendMessage(params: { linkId: string; text: string }): { error: string | null };
  connect(params: { linkId: string }): void;
  disconnect(params: { linkId: string }): void;
  addService(params: { name: string; target: string }): { serviceId: string };
  removeService(params: { serviceId: string }): void;
  setServiceEnabled(params: { serviceId: string; enabled: boolean }): void;
  updateSettings(params: { settings: Partial<Settings> }): void;
  setCallSignal(params: { linkId: string; signal: string | null }): void;
  setFastPoll(params: { linkId: string; fast: boolean }): void;
}

/** What the engine implements: any call may be answered asynchronously. */
export type EngineImplementation = {
  [M in keyof EngineApi]: EngineApi[M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};

export type EngineMethod = keyof EngineApi;
type Params<M extends EngineMethod> = Parameters<EngineApi[M]> extends [infer P] ? P : undefined;

export interface RpcRequest<M extends EngineMethod = EngineMethod> {
  kind: "request";
  id: number;
  method: M;
  params: Params<M>;
}

export interface RpcResponse {
  kind: "response";
  id: number;
  result?: unknown;
  error?: string;
}

export type EngineEvent =
  | { kind: "state"; state: EngineState }
  | { kind: "messages"; linkId: string; messages: StoredMessage[] }
  | { kind: "call-signal"; linkId: string; signal: string };

export const UI_PORT = "ui";

/** One-shot messages, addressed by `target` because every context hears them. */
export type RuntimeMessage =
  | { target: "background"; type: "ensure-engine" }
  | { target: "background"; type: "open-service"; peerPubKeyZ32: string; serviceId: string }
  | { target: "engine"; type: "ping" }
  | {
      target: "engine";
      type: "http-request";
      peerPubKeyZ32: string;
      serviceId: string;
      method: string;
      path: string;
      headers: [string, string][];
      bodyB64: string | null;
    };

export type HttpRequestReply =
  | { ok: true; status: number; headers: [string, string][]; bodyB64: string }
  | { ok: false; code: string; message: string };
