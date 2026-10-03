import type { EngineEvent, RpcRequest, RpcResponse } from "../shared/rpc";
import type { DeviceGate, DeviceGateView } from "./gate";

/*
 * Device-link-only mode (WISP 06 § The gate): what runs in place of the engine on a device that is not the active one.
 * It knows the device state, and will know the turn record and the device links. It never opens the peer database,
 * starts no wallet, publishes no DID or proof record, starts no chat or group link and polls no hold storage.
 *
 * In this version it is a shell: it tells each page which state the device is in and refuses every engine call. The
 * turn record, the device links, enrollment and the handoff plug in through `DeviceLinkEngine`.
 */

/** A page of the app, as the engine's server knows it too (`engine/server.ts`). */
export interface PeerClientSink {
  post(message: EngineEvent | RpcResponse): void;
}

/**
 * What a host runs for a profile: the whole engine (`EngineServer`) or device-link-only mode (`DeviceLinkOnlyServer`).
 * `gated` tells them apart without importing either.
 */
export interface PeerServer {
  readonly gated: boolean;
  readonly ready: Promise<void>;
  attach(client: PeerClientSink): void;
  detach(client: PeerClientSink): void;
  handle(client: PeerClientSink, request: RpcRequest): Promise<void>;
  /** Says goodbye and stops, as the page or the document goes away. */
  stop(): Promise<void>;
}

/**
 * The small engine of a standby: the turn record and the device links (later parts of WISP 06). It gets the gate it
 * started under, and may tell the pages when what they show changes. It must never open the profile's peer database.
 */
export interface DeviceLinkEngine {
  start(host: DeviceLinkHost): Promise<void>;
  stop(): Promise<void>;
  /** A call from a page whose method starts with `device`: reading the turn, asking for a handoff, and so on. */
  call(method: string, params: unknown): Promise<unknown>;
}

export interface DeviceLinkHost {
  readonly gate: DeviceGate;
  /** Tells every page what the standby screen shows now. */
  show(view: DeviceGateView): void;
}

/** What every engine call is answered with on a device that is not the active one. */
export const DEVICE_GATED_ERROR = "This profile is not active on this device";

/** The engine of this version: nothing runs, and there is nothing to call yet. */
export const idleDeviceLinkEngine = (): DeviceLinkEngine => ({
  start: async () => {},
  stop: async () => {},
  call: async (method) => { throw new Error(`${DEVICE_GATED_ERROR} (${method} is not available yet)`); },
});

export class DeviceLinkOnlyServer implements PeerServer {
  readonly gated = true;
  readonly ready: Promise<void>;
  private readonly clients = new Set<PeerClientSink>();
  private view: DeviceGateView;

  constructor(readonly gate: DeviceGate, private readonly engine: DeviceLinkEngine = idleDeviceLinkEngine()) {
    if (gate.full || !gate.view) throw new Error("Device-link-only mode is for a device that is not active");
    this.view = gate.view;
    this.ready = engine.start({ gate, show: (view) => this.show(view) });
    // A start that fails leaves the device as it is, on standby: the pages still get the state.
    this.ready.catch(() => {});
  }

  attach(client: PeerClientSink): void {
    this.clients.add(client);
    this.post(client, { kind: "device-gate", gate: this.view });
  }

  detach(client: PeerClientSink): void {
    this.clients.delete(client);
  }

  async handle(client: PeerClientSink, request: RpcRequest): Promise<void> {
    if (request?.kind !== "request") return;
    const response: RpcResponse = { kind: "response", id: request.id };
    try {
      const method = String(request.method);
      if (!method.startsWith("device")) throw new Error(DEVICE_GATED_ERROR);
      response.result = await this.engine.call(method, request.params);
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    try { client.post(response); } catch { /* the page went away */ }
  }

  stop(): Promise<void> {
    return this.engine.stop().catch(() => {});
  }

  private show(view: DeviceGateView): void {
    this.view = view;
    for (const client of [...this.clients]) this.post(client, { kind: "device-gate", gate: view });
  }

  private post(client: PeerClientSink, event: EngineEvent): void {
    try { client.post(event); } catch { this.clients.delete(client); }
  }
}
