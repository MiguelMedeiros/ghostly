import type { BrowserContext, Route } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A Pkarr relay that lives in the test process. Peers on the web have every
 * request to the public relays answered from here; the extension, whose peer
 * runs where requests cannot be intercepted, is pointed at its HTTP address.
 * Either way the suite needs no network, is never rate limited, and one
 * test's packets never reach another's.
 *
 * It keeps what a real relay keeps: the newest signed packet per key
 * (`<64 bytes signature><8 bytes timestamp (µs)><DNS packet>`). Signatures are
 * checked by the peers when they read, as they would be with a real relay.
 */
export class LocalRelay {
  readonly packets = new Map<string, Buffer>();
  puts = 0;
  gets = 0;
  private server: Server | null = null;

  static readonly pattern = /^https:\/\/pkarr\.pubky\.(org|app)\//;

  private static readonly cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
  };

  /** Answers this context's requests to the public relays. */
  async attach(context: BrowserContext): Promise<void> {
    await context.route(LocalRelay.pattern, (route) => this.fulfill(route));
  }

  /** The relay on a real port (`port`, or any free one), for peers whose requests cannot be intercepted. Resolves to its URL. */
  async listen(port = 0): Promise<string> {
    if (!this.server) {
      this.server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const answer = this.answer(request.method ?? "GET", new URL(request.url ?? "/", "http://relay").pathname.slice(1), Buffer.concat(chunks));
          response.writeHead(answer.status, { ...LocalRelay.cors, ...(answer.body ? { "content-type": "application/octet-stream" } : {}) });
          response.end(answer.body);
        });
      });
      await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    }
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private async fulfill(route: Route): Promise<void> {
    const request = route.request();
    const answer = this.answer(request.method(), new URL(request.url()).pathname.slice(1), request.postDataBuffer());
    await route.fulfill({ status: answer.status, headers: LocalRelay.cors, body: answer.body });
  }

  private answer(method: string, key: string, body: Buffer | null): { status: number; body?: Buffer } {
    if (method === "OPTIONS") return { status: 204 };
    if (method === "PUT") {
      this.puts++;
      if (!body || body.length < 72) return { status: 400 };
      const known = this.packets.get(key);
      if (!known || timestamp(body) >= timestamp(known)) this.packets.set(key, body);
      return { status: 204 };
    }
    this.gets++;
    const packet = this.packets.get(key);
    return packet ? { status: 200, body: packet } : { status: 404 };
  }
}

const timestamp = (packet: Buffer) => packet.readBigUInt64BE(64);
