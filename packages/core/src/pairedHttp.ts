import { fromBase64Url, toBase64Url } from "./bytes";
import { CHUNK_KIND, decodeChunk, decodeControl, type FrameChannel } from "./frames";
import { HttpClient, HttpHost, type HostedHttpService, type LocalFetch } from "./http";

/**
 * Shared services over a paired session: the same HTTP frames as the older data link, carried as
 * `ph` application frames on the authenticated channel. Binary chunks travel base64url-encoded,
 * since paired application data is text. The frames carry no `id`, so an older app drops them.
 */
export class PairedHttp {
  readonly client: HttpClient;
  readonly host: HttpHost;

  constructor(channel: FrameChannel, getService: (id: string) => HostedHttpService | undefined, localFetch: LocalFetch) {
    const tunnel: FrameChannel = {
      send: (data) => channel.send(JSON.stringify(typeof data === "string" ? { t: "ph", c: data } : { t: "ph", b: toBase64Url(data) })),
      get bufferedAmount() { return channel.bufferedAmount; },
      drained: () => channel.drained(),
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
