import { fromBase64Url, toBase64Url } from "./bytes";
import { CHUNK_KIND, decodeChunk, decodeControl, type FrameChannel } from "./frames";
import { HttpClient, HttpHost, type HostedHttpService, type LocalFetch } from "./http";

/**
 * What the session hears of the bodies going on its channel: each chunk written, with its frame's length, and each wait
 * for room. An app's data in the chat keeps its own share above them, as beside a file (WISP 1200 § In a chat).
 */
export interface PairedHttpBodies {
  wrote(bytes: number): void;
  waiting(drained: Promise<void>): Promise<void>;
}

/**
 * Shared services over a paired session: the same HTTP frames as the older data link, carried as
 * `ph` application frames on the authenticated channel. Binary chunks travel base64url-encoded,
 * since paired application data is text. The frames carry no `id`, so an older app drops them.
 */
export class PairedHttp {
  readonly client: HttpClient;
  readonly host: HttpHost;

  constructor(channel: FrameChannel, getService: (id: string) => HostedHttpService | undefined, localFetch: LocalFetch, bodies?: PairedHttpBodies) {
    const tunnel: FrameChannel = {
      send: (data) => {
        if (typeof data === "string") return channel.send(JSON.stringify({ t: "ph", c: data }));
        // Only a body's chunks are binary.
        const frame = JSON.stringify({ t: "ph", b: toBase64Url(data) });
        channel.send(frame);
        bodies?.wrote(frame.length);
      },
      get bufferedAmount() { return channel.bufferedAmount; },
      // Only a body waits for room.
      drained: () => bodies ? bodies.waiting(channel.drained()) : channel.drained(),
      // Its frames are counted on the session's channel, base64url and all, so a body keeps under that channel's budget.
      get sendBudget() { return channel.sendBudget; },
      // The paired channel belongs to the session; closing is the session's business.
      close: () => {},
      onMessage: null,
      onClose: null,
    };
    this.client = new HttpClient(tunnel);
    this.host = new HttpHost(tunnel, getService, localFetch);
  }

  /** One `ph` frame from the peer. Anything that is not HTTP traffic is ignored. */
  handle(frame: Record<string, unknown>): void {
    if (typeof frame.b === "string") {
      let bytes: Uint8Array;
      try { bytes = fromBase64Url(frame.b); } catch { return; }
      const chunk = decodeChunk(bytes);
      if (chunk?.kind === CHUNK_KIND.requestBody) this.host.handleChunk(chunk);
      else if (chunk?.kind === CHUNK_KIND.responseBody) this.client.handleChunk(chunk);
      return;
    }
    if (typeof frame.c !== "string") return;
    const control = decodeControl(frame.c);
    if (control?.t === "req") this.host.handleRequest(control);
    else if (control?.t === "res") this.client.handleResponse(control);
    else if (control?.t === "rst" && control.d === "q") this.host.handleReset(control);
    else if (control?.t === "rst" && control.d === "s") this.client.handleReset(control);
  }

  close(): void {
    this.host.closeAll();
    this.client.close();
  }
}
