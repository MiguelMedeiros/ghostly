import type { BrowserContext } from "@playwright/test";
import { createSocket, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";

/**
 * A STUN server that lives in the test process, for the public ones the apps ask (Google's, `RTC_CONFIG`). A peer
 * waits for its server reflexive candidate before it publishes an offer or an answer, up to 5 s (`waitForIceGathering`,
 * `ICE_GATHERING_TIMEOUT_MS`): when Google's servers answered late, a join through a link that takes seconds took 5 or 10
 * more (2026-09-29). This one answers every binding request at once with the address it came from.
 *
 * Every peer is on this machine: the reflexive address it learns here (a loopback one, on its host candidate's port)
 * reaches it as well as its host address does, and comes within milliseconds.
 */
const PUBLIC_STUN = /^stuns?:stun[0-9]*\.l\.google\.com(:[0-9]+)?$/;
const MAGIC_COOKIE = 0x2112a442;

let server: Promise<string> | null = null;

/** Starts this worker's server (once) and resolves to its URL. */
export function localStunUrl(): Promise<string> {
  server ??= new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.on("message", (message, from) => answer(socket, message, from));
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.unref();
      resolve(`stun:127.0.0.1:${(socket.address() as AddressInfo).port}`);
    });
  });
  return server;
}

/** Points this context's peer connections at the local server instead of the public STUN servers. Before its pages open. */
export async function useLocalStun(context: BrowserContext): Promise<void> {
  const url = await localStunUrl();
  await context.addInitScript(({ url, pattern }) => {
    const publicStun = new RegExp(pattern);
    const Native = window.RTCPeerConnection;
    const local = (config?: RTCConfiguration): RTCConfiguration | undefined => config && {
      ...config,
      iceServers: config.iceServers?.map(server => ({ ...server, urls: [...new Set([server.urls].flat().map(u => publicStun.test(u) ? url : u))] })),
    };
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super(local(config)); }
      override setConfiguration(config?: RTCConfiguration): void { super.setConfiguration(local(config)); }
    };
  }, { url, pattern: PUBLIC_STUN.source });
}

/** A Binding success response to a Binding request (RFC 8489): XOR-MAPPED-ADDRESS, the request's source. */
function answer(socket: Socket, message: Buffer, from: AddressInfo): void {
  if (message.length < 20 || message.readUInt16BE(0) !== 0x0001 || message.readUInt32BE(4) !== MAGIC_COOKIE || from.family !== "IPv4") return;
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(0x0020, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt16BE(0x0001, 4);
  attribute.writeUInt16BE(from.port ^ (MAGIC_COOKIE >>> 16), 6);
  attribute.writeUInt32BE((from.address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0) ^ MAGIC_COOKIE) >>> 0, 8);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);
  header.writeUInt16BE(attribute.length, 2);
  message.copy(header, 4, 4, 20);
  socket.send(Buffer.concat([header, attribute]), from.port, from.address);
}
