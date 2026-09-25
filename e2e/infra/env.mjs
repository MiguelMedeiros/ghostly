// The end-to-end environment's contract: every variable the gated suites read, what it means, and its value
// when e2e/infra is up. These names are stable — other suites (the scenario matrix among them) build on them;
// add new ones, never rename or repurpose one.
//
// `npm run e2e:infra:up` writes them all to `.env.e2e` at the repository root, and e2e/playwright.config.ts
// loads that file when it exists (a variable already set in the shell wins). Specs and support scripts read
// endpoints through `endpoints` below, never a literal port: set a variable to point a suite somewhere else.
//
// Three endpoints are also the web app's own Regtest options (ArkWalletPanel, BarkWalletPanel,
// UsdtWalletPanel): the Ark and Bark servers, their Esplora and the local EVM chain. Those are baked into the
// build, so the defaults here must stay what the app names.

/** Every container of the environment is named `ghostly-e2e-<service>`, the service's name in docker-compose.yml. */
export const PROJECT = "ghostly-e2e";
export const container = (service) => `${PROJECT}-${service}`;

/** What `.env.e2e` holds when the environment is up: name → [value, what it is]. */
export const VARIABLES = {
  // Gates: each suite that needs a real service runs only when its variable is "1", and is skipped otherwise.
  GHOSTLY_ARK_REGTEST: ["1", "Ark (Arkade) wallet suites: arkd on regtest"],
  GHOSTLY_BARK_REGTEST: ["1", "Bark (Second's Ark) suites: captaind on regtest"],
  GHOSTLY_BDK_REGTEST: ["1", "BDK on-chain wallet suites (web and extension): the regtest chain's Esplora"],
  GHOSTLY_BITCOIND_REGTEST: ["1", "Bitcoin Core source contract test (vitest): the regtest bitcoind's RPC"],
  GHOSTLY_FEDIMINT_REGTEST: ["1", "Fedimint suites: a one-guardian federation, its LND gateway and an LND peer"],
  GHOSTLY_CLN_REGTEST: ["1", "Core Lightning source suites: two CLN nodes with a channel"],
  GHOSTLY_LND_REGTEST: ["1", "LND source suites: two LND nodes with a channel, REST from the page"],
  GHOSTLY_NWC_REGTEST: ["1", "Nostr Wallet Connect suites: two Alby Hubs on two LND nodes, a local relay"],
  GHOSTLY_USDT_LOCAL: ["1", "USDT suites: the local EVM chain with the test token deployed"],
  GHOSTLY_WEBLN_REGTEST: ["1", "WebLN suites: two LND nodes behind the injected browser wallets"],

  // Harness: ports of the suite's own servers. Defaults only, never written to .env.e2e — other runners (the scenario
  // matrix) read the same names for ranges of their own.
  E2E_WEB_PORT: ["47100", "Port the suite serves the web build on (vite preview); LND's restcors allows this origin"],
  E2E_MINT_URL: ["http://127.0.0.1:47090", "Cashu test mint answering for testnut.cashu.space (support/mint.ts)"],
  E2E_LNURL_PORT: ["47110", "First port the in-process Lightning address server tries (support/lnurl.ts; ten ports)"],
  E2E_DOMAIN_PORT: ["47120", "First port of the in-process domain-proof servers (support/domain.ts; two per worker slot)"],

  // The regtest chain.
  GHOSTLY_BITCOIND_RPC_URL: ["http://127.0.0.1:47001", "bitcoind RPC (regtest)"],
  GHOSTLY_BITCOIND_RPC_USER: ["ghostly", "bitcoind RPC user"],
  GHOSTLY_BITCOIND_RPC_PASSWORD: ["regtest", "bitcoind RPC password (worthless regtest node)"],
  GHOSTLY_ESPLORA_URL: ["http://127.0.0.1:47002", "Esplora API of the regtest chain (electrs, CORS open)"],

  // Ark and Bark (the servers and explorer are the web app's Regtest options).
  GHOSTLY_ARK_SERVER_URL: ["http://127.0.0.1:47010", "arkd (Arkade) server"],
  GHOSTLY_ARK_ESPLORA_URL: ["http://127.0.0.1:47002", "Esplora the Ark wallets read"],
  GHOSTLY_BARK_SERVER_URL: ["http://127.0.0.1:47020", "captaind (Bark) server"],
  GHOSTLY_BARK_ESPLORA_URL: ["http://127.0.0.1:47002", "Esplora the Bark wallets read"],

  // Lightning. Node pairs are per suite: the tests assert exact balances and run in parallel.
  GHOSTLY_LND_ALICE_URL: ["https://127.0.0.1:47030", "LND REST, Alice's node of the LND suite"],
  GHOSTLY_LND_BOB_URL: ["https://127.0.0.1:47031", "LND REST, Bob's node of the LND suite"],
  GHOSTLY_WEBLN_ALICE_URL: ["https://127.0.0.1:47040", "LND REST behind Alice's WebLN wallet"],
  GHOSTLY_WEBLN_BOB_URL: ["https://127.0.0.1:47041", "LND REST behind Bob's WebLN wallet"],
  GHOSTLY_CLN_ALICE_WS: ["ws://127.0.0.1:47050", "Core Lightning Commando websocket, alice"],
  GHOSTLY_CLN_BOB_WS: ["ws://127.0.0.1:47051", "Core Lightning Commando websocket, bob"],
  GHOSTLY_NWC_RELAY_URL: ["ws://127.0.0.1:47060", "Nostr relay (strfry) the NWC wallet services answer on"],
  GHOSTLY_NWC_ALICE_LND_URL: ["https://127.0.0.1:47061", "LND REST under Alice's Alby Hub"],
  GHOSTLY_NWC_BOB_LND_URL: ["https://127.0.0.1:47062", "LND REST under Bob's Alby Hub"],
  GHOSTLY_NWC_ALICE_HUB_URL: ["http://127.0.0.1:47063", "Alice's Alby Hub (its own HTTP API, for pairing)"],
  GHOSTLY_NWC_BOB_HUB_URL: ["http://127.0.0.1:47064", "Bob's Alby Hub"],

  // Fedimint. The invite code names the guardian's API; e2e/support/fedimint-regtest/regtest.mjs `invite` prints it.
  GHOSTLY_FEDIMINT_API_URL: ["ws://127.0.0.1:47140", "Fedimint guardian API (websocket), as the invite code names it"],
  GHOSTLY_FEDIMINT_GATEWAY_URL: ["http://127.0.0.1:47141", "Fedimint gateway API (gatewayd, LND-backed)"],

  // USDT (the RPC is the web app's "Local test chain").
  GHOSTLY_USDT_RPC_URL: ["http://127.0.0.1:47070", "Anvil, chain 31337"],
  GHOSTLY_USDT_TOKEN: ["0x5FbDB2315678afecb367f032d93F642f64180aa3", "TestUSDT contract (first deployment of Anvil's first account)"],

  // S3 (held messages, profile backups): RustFS with throwaway keys.
  GHOSTLY_S3_ENDPOINT: ["http://127.0.0.1:47080", "S3-compatible endpoint (RustFS)"],
  GHOSTLY_S3_KEY: ["ghostly-e2e", "S3 access key (local server)"],
  GHOSTLY_S3_SECRET: ["ghostly-e2e-worthless", "S3 secret key (local server)"],
};

/** The suite's own ports: `npm run e2e:full` passes them to its children, `.env.e2e` leaves them out. */
export const HARNESS_PORTS = ["E2E_WEB_PORT", "E2E_LNURL_PORT", "E2E_DOMAIN_PORT"];

/**
 * Every port the environment publishes for an endpoint above, in order, and arkd's admin API: the port after its
 * public one (support/ark-regtest), which stays the next one here too.
 */
export const SERVICE_PORTS = [...new Set(Object.entries(VARIABLES).filter(([name]) => !HARNESS_PORTS.includes(name))
  .flatMap(([, [value]]) => { const match = /^\w+:\/\/127\.0\.0\.1:(\d+)/.exec(value); return match ? [Number(match[1])] : []; }))]
  .concat(Number(new URL(VARIABLES.GHOSTLY_ARK_SERVER_URL[0]).port) + 1).sort((a, b) => a - b);

/**
 * The port of this machine a published port is reached on. The same one, even with the environment on another host
 * (remote.mjs forwards it here: the app takes plain HTTP and WS from loopback only); or, with
 * E2E_INFRA_LOCAL_PORTS=<base>, base, base+1, … (19 ports) in SERVICE_PORTS order, to stay clear of ports held here.
 */
export const localPort = (port) => (process.env.E2E_INFRA_LOCAL_PORTS ? Number(process.env.E2E_INFRA_LOCAL_PORTS) + SERVICE_PORTS.indexOf(port) : port);
const here = (value) => value.replace(/127\.0\.0\.1:(\d+)/, (_, port) => `127.0.0.1:${localPort(Number(port))}`);

/** A variable's value: the shell's if set, the environment's default (at this machine's port for it) otherwise. */
export const read = (name) => process.env[name] || here(VARIABLES[name][0]);

/** Where each service is, as the host reaches it: the variable if set, the environment's default otherwise. */
export const endpoints = {
  webPort: Number(read("E2E_WEB_PORT")),
  lnurlPort: Number(read("E2E_LNURL_PORT")),
  domainPort: Number(read("E2E_DOMAIN_PORT")),
  bitcoind: { url: read("GHOSTLY_BITCOIND_RPC_URL"), user: read("GHOSTLY_BITCOIND_RPC_USER"), password: read("GHOSTLY_BITCOIND_RPC_PASSWORD") },
  esplora: read("GHOSTLY_ESPLORA_URL"),
  ark: { server: read("GHOSTLY_ARK_SERVER_URL"), esplora: read("GHOSTLY_ARK_ESPLORA_URL") },
  bark: { server: read("GHOSTLY_BARK_SERVER_URL"), esplora: read("GHOSTLY_BARK_ESPLORA_URL") },
  lnd: { alice: read("GHOSTLY_LND_ALICE_URL"), bob: read("GHOSTLY_LND_BOB_URL") },
  webln: { alice: read("GHOSTLY_WEBLN_ALICE_URL"), bob: read("GHOSTLY_WEBLN_BOB_URL") },
  cln: { alice: read("GHOSTLY_CLN_ALICE_WS"), bob: read("GHOSTLY_CLN_BOB_WS") },
  nwc: {
    relay: read("GHOSTLY_NWC_RELAY_URL"),
    lnd: { alice: read("GHOSTLY_NWC_ALICE_LND_URL"), bob: read("GHOSTLY_NWC_BOB_LND_URL") },
    hub: { alice: read("GHOSTLY_NWC_ALICE_HUB_URL"), bob: read("GHOSTLY_NWC_BOB_HUB_URL") },
  },
  fedimint: { api: read("GHOSTLY_FEDIMINT_API_URL"), gateway: read("GHOSTLY_FEDIMINT_GATEWAY_URL") },
  usdt: { rpc: read("GHOSTLY_USDT_RPC_URL"), token: read("GHOSTLY_USDT_TOKEN") },
  s3: { endpoint: read("GHOSTLY_S3_ENDPOINT"), key: read("GHOSTLY_S3_KEY"), secret: read("GHOSTLY_S3_SECRET") },
};

/** `host:port` of a URL, the way the app shows where a service is. */
export const hostOf = (url) => new URL(url).host;

/** Written to `.env.e2e` only when the environment runs on another host (`--host`, remote.mjs). */
export const REMOTE = {
  E2E_INFRA_HOST: "SSH target the environment runs on (its Docker); unset: this machine",
  E2E_INFRA_ADDRESS: "Its Tailscale address, where its ports are published (and forwarded here from)",
  E2E_INFRA_LOCAL_PORTS: "First port of this machine the endpoints above were forwarded to, when not their own",
  DOCKER_HOST: "Docker of that host, for the scripts and tests that `docker exec` into the environment",
};

/** The `.env.e2e` file: every variable of the environment with its value, commented. */
export function dotenv(values = {}) {
  const lines = ["# Written by `npm run e2e:infra:up` (e2e/infra/infra.mjs); removed by `npm run e2e:infra:down`.",
    "# Worthless regtest coins, test tokens and throwaway keys only. Names are listed in e2e/infra/env.mjs."];
  for (const [name, [value, about]] of Object.entries(VARIABLES)) {
    if (!HARNESS_PORTS.includes(name)) lines.push(`# ${about}`, `${name}=${values[name] ?? here(value)}`);
  }
  // On another host (remote.mjs): where it is, and Docker pointed there for the scripts and tests that `docker exec`.
  for (const [name, about] of Object.entries(REMOTE)) {
    if (process.env[name]) lines.push(`# ${about}`, `${name}=${process.env[name]}`);
  }
  return `${lines.join("\n")}\n`;
}
