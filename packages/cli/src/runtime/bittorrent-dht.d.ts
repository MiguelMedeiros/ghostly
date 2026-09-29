/** The part of bittorrent-dht (no types of its own) the Mainline transport uses: BEP44 mutable put and get. */
declare module "bittorrent-dht" {
  import { EventEmitter } from "node:events";
  interface MutablePut { k: Buffer; v: Buffer; seq: number; sig?: Buffer; sign?: (message: Buffer) => Buffer; salt?: Buffer; cas?: number }
  interface GetResult { v: Buffer; k?: Buffer; seq: number; sig?: Buffer }
  export default class DHT extends EventEmitter {
    constructor(options?: { bootstrap?: string[] | false; host?: string | false; verify?: (sig: Uint8Array, message: Uint8Array, key: Uint8Array) => boolean });
    listen(port?: number, address?: string, onListening?: () => void): void;
    address(): { address: string; family: string; port: number };
    addNode(node: { host: string; port: number }): void;
    put(options: MutablePut, done: (error: Error | null, hash: Buffer, nodes: number) => void): Buffer;
    get(target: Buffer, options: { cache?: boolean; salt?: Buffer }, done: (error: Error | null, result: GetResult | null) => void): void;
    destroy(done?: () => void): void;
  }
}
