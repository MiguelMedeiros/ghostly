/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableByteStreamController): Promise<any>;
  start(controller: ReadableByteStreamController): void;
  cancel(): void;
  readonly autoAllocateChunkSize: number;
  readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  abort(reason: any): Promise<any>;
  close(): Promise<any>;
  write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableStreamDefaultController): Promise<any>;
  cancel(): void;
}

export class IrohConn {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Round-trip time in milliseconds, as QUIC measures it.
   */
  rtt(): number;
  /**
   * The next text frame, or `undefined` once the channel is closed.
   */
  recv(): Promise<any>;
  /**
   * Sends one text frame. Callers serialise sends; a concurrent call fails.
   */
  send(text: string): Promise<any>;
  close(): void;
  binding(): any;
  /**
   * The contact's endpoint id.
   */
  remoteId(): string;
}

export class IrohNode {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  close(): Promise<any>;
  /**
   * Binds an endpoint for a 32-byte seed and waits until it is reachable
   * through the first relay that answers. `relays` is a list of relay URLs.
   */
  static start(seed: Uint8Array, relays: string[], online_ms: number): Promise<any>;
  /**
   * Resolves with the next incoming connection, or `undefined` once closed.
   */
  accept(): Promise<any>;
  /**
   * `{ id, relay, addresses: [] }`, the same shape the Desktop publishes.
   */
  address(): any;
  connect(descriptor: any, timeout_ms: number): Promise<any>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_irohconn_free: (a: number, b: number) => void;
  readonly __wbg_irohnode_free: (a: number, b: number) => void;
  readonly irohconn_binding: (a: number, b: number) => void;
  readonly irohconn_close: (a: number) => void;
  readonly irohconn_recv: (a: number) => number;
  readonly irohconn_remoteId: (a: number, b: number) => void;
  readonly irohconn_rtt: (a: number) => number;
  readonly irohconn_send: (a: number, b: number, c: number) => number;
  readonly irohnode_accept: (a: number) => number;
  readonly irohnode_address: (a: number, b: number) => void;
  readonly irohnode_close: (a: number) => number;
  readonly irohnode_connect: (a: number, b: number, c: number) => number;
  readonly irohnode_start: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
  readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
  readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
  readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
  readonly intounderlyingbytesource_cancel: (a: number) => void;
  readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
  readonly intounderlyingbytesource_start: (a: number, b: number) => void;
  readonly intounderlyingbytesource_type: (a: number) => number;
  readonly intounderlyingsink_abort: (a: number, b: number) => number;
  readonly intounderlyingsink_close: (a: number) => number;
  readonly intounderlyingsink_write: (a: number, b: number) => number;
  readonly intounderlyingsource_cancel: (a: number) => void;
  readonly intounderlyingsource_pull: (a: number, b: number) => number;
  readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly __wasm_bindgen_func_elem_3228: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_3222: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_1064: (a: number, b: number, c: number) => void;
  readonly __wasm_bindgen_func_elem_688: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_3552: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_3547: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_8887: (a: number, b: number, c: number) => void;
  readonly __wasm_bindgen_func_elem_8874: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_4120: (a: number, b: number, c: number) => void;
  readonly __wasm_bindgen_func_elem_4085: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_3581: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_3561: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_8842: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_8831: (a: number, b: number) => void;
  readonly __wasm_bindgen_func_elem_8979: (a: number, b: number, c: number, d: number) => void;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export3: (a: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
