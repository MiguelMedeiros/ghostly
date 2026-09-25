// @hyperswarm/dht-relay ships no types; hyperdhtRelay.ts describes the parts it uses.
declare module "@hyperswarm/dht-relay" {
  const RelayedDHT: new (stream: unknown, options?: { custodial?: boolean; keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array } }) => unknown;
  export default RelayedDHT;
}
declare module "@hyperswarm/dht-relay/ws" {
  const WebSocketStream: new (isInitiator: boolean, socket: WebSocket) => unknown;
  export default WebSocketStream;
}
