declare module "hyperdht/testnet.js" {
  export default function createTestnet(size: number, options?: { host?: string }): Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }>;
}
