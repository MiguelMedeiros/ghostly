import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo, LookupFunction, Socket } from "node:net";
import { expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { nodePublicRelay } from "../src/runtime/irohRelay";
import { publicOnly } from "../src/runtime/pushSend";

// covers: transport.iroh-web

/** A DNS that answers each name from a table: no lookup leaves this machine. */
const answers = (table: Record<string, string[]>) => publicOnly((host, _options, callback) =>
  table[host] ? callback(null, table[host].map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) :
    callback(Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" }), []));

it("takes a contact's Iroh relay only at a name whose every address is public now, or at a public address", async () => {
  const publicRelay = nodePublicRelay(answers({
    "relay.contact.example": ["127.0.0.1"],
    "lan.contact.example": ["192.168.1.10"],
    "mixed.contact.example": ["8.8.8.8", "::1"],
    "public.contact.example": ["8.8.8.8", "2001:4860:4860::8888"],
  }));
  for (const relay of ["https://relay.contact.example:5881/", "https://lan.contact.example/", "https://relay.contact.example./",
    "https://mixed.contact.example/", "https://nowhere.contact.example/", "https://127.0.0.1/", "https://[::1]/", "not a relay"])
    expect(await publicRelay(relay), relay).toBe(false);
  for (const relay of ["https://public.contact.example/", "https://8.8.8.8/", "https://[2001:4860:4860::8888]/"])
    expect(await publicRelay(relay), relay).toBe(true);
});

/** A WebSocket server on this machine that echoes, counting the TCP connections it gets. */
async function echoServer() {
  const tcp = createServer();
  const seen = { connections: 0 };
  const sockets = new Set<Socket>();
  tcp.on("connection", socket => { seen.connections++; sockets.add(socket); });
  new WebSocketServer({ server: tcp }).on("connection", socket => socket.on("message", data => socket.send(data)));
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve));
  return { port: (tcp.address() as AddressInfo).port, seen, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); tcp.close(resolve); }) };
}

/** What a socket does first: opens, fails, or neither within 3 s (a TLS handshake a plain server never answers). */
const outcome = (socket: WebSocket) => new Promise<string>(resolve => {
  socket.onopen = () => resolve("open");
  socket.onerror = () => resolve("error");
  setTimeout(() => resolve("pending"), 3_000);
});

it("opens a contact's Iroh relay that the check took only at an address the check takes, each time the wasm connects", async () => {
  const echo = await echoServer();
  const table: Record<string, string[]> = { "rebind.contact.example": ["8.8.8.8"] };
  const system = dns.lookup;
  try {
    expect(await nodePublicRelay(answers(table))(`https://rebind.contact.example:${echo.port}/`)).toBe(true);
    // The name now answers this machine, to the check's lookup and to the system's, which the global WebSocket uses.
    table["rebind.contact.example"] = ["127.0.0.1"];
    Object.assign(dns, { lookup: (host: string, options: unknown, callback: unknown) => host === "rebind.contact.example" ?
      (typeof options === "function" ? options : callback as (...args: unknown[]) => void)(null, [{ address: "127.0.0.1", family: 4 }]) :
      (system as (...args: unknown[]) => void)(host, options, callback) });
    for (const url of [`wss://rebind.contact.example:${echo.port}/relay`, `ws://rebind.contact.example:${echo.port}/relay`]) {
      // The wasm opens its relay with the global WebSocket (packages/iroh-web/pkg).
      expect(await outcome(new WebSocket(url)), url).toBe("error");
    }
    expect(echo.seen.connections).toBe(0);
  } finally {
    Object.assign(dns, { lookup: system });
    await echo.close();
  }
});

it("a contact's relay opened through the check's lookup works as the wasm uses it; any other socket is the global one", async () => {
  const echo = await echoServer();
  try {
    const takesAll = ((_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as LookupFunction;
    expect(await nodePublicRelay(takesAll)(`http://echo.contact.example:${echo.port}/`)).toBe(true);
    const socket = new WebSocket(`ws://echo.contact.example:${echo.port}/relay`);
    socket.binaryType = "arraybuffer";
    expect(await outcome(socket)).toBe("open");
    const reply = new Promise<unknown>(resolve => { socket.onmessage = event => resolve(event.data); });
    socket.send(new Uint8Array([1, 2, 3]));
    const data = await reply;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([1, 2, 3]);
    const closed = new Promise<{ code: number; wasClean: boolean }>(resolve => { socket.onclose = resolve; });
    socket.close();
    expect(await closed).toMatchObject({ code: 1005, wasClean: true });
    const own = new WebSocket(`ws://127.0.0.1:${echo.port}/`);
    expect(own).not.toBeInstanceOf(NodeWebSocket);
    expect(await outcome(own)).toBe("open");
    own.close();
    expect(echo.seen.connections).toBe(2);
  } finally {
    await echo.close();
  }
});
