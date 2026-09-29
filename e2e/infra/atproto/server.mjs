// A local AT Protocol network for the e2e suite: a PLC directory (in memory) and a reference PDS,
// in one process. The PDS believes it is https://pds.ghostly.test; the tests route that name (and
// https://plc.ghostly.test) to these ports, so the app under test only ever sees HTTPS URLs.
// Accounts are seeded from ATPROTO_ACCOUNTS ("alice,bob"): <name>.pds.ghostly.test, password
// "ghostly-<name>". Test-only credentials on a throwaway server; nothing here is a secret.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDS, envToCfg, envToSecrets, readEnv } from "@atproto/pds";
import { PlcServer, Database as PlcDatabase } from "@did-plc/server";
import { Secp256k1Keypair } from "@atproto/crypto";

const PLC_PORT = Number(process.env.ATPROTO_PLC_PORT ?? 2582);
const PDS_PORT = Number(process.env.ATPROTO_PDS_PORT ?? 2583);
const HOSTNAME = process.env.ATPROTO_PDS_HOSTNAME ?? "pds.ghostly.test";
const ACCOUNTS = (process.env.ATPROTO_ACCOUNTS ?? "alice,bob").split(",").map(s => s.trim()).filter(Boolean);

const plc = PlcServer.create({ db: PlcDatabase.mock(), port: PLC_PORT });
await plc.start();

const dir = mkdtempSync(join(tmpdir(), "ghostly-pds-"));
const rotation = await Secp256k1Keypair.create({ exportable: true });
const hex = Buffer.from(await rotation.export()).toString("hex");
Object.assign(process.env, {
  PDS_HOSTNAME: HOSTNAME,
  PDS_PORT: String(PDS_PORT),
  PDS_DATA_DIRECTORY: dir,
  PDS_BLOBSTORE_DISK_LOCATION: join(dir, "blobs"),
  PDS_JWT_SECRET: "ghostly-e2e-jwt-secret",
  PDS_ADMIN_PASSWORD: "ghostly-e2e-admin",
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: hex,
  PDS_DID_PLC_URL: `http://127.0.0.1:${PLC_PORT}`,
  PDS_DEV_MODE: "true",
  PDS_INVITE_REQUIRED: "false",
  PDS_CRAWLERS: "",
  LOG_ENABLED: process.env.LOG_ENABLED ?? "false",
});
const env = readEnv();
const pds = await PDS.create(envToCfg(env), envToSecrets(env));
await pds.start();

for (const name of ACCOUNTS) {
  const handle = `${name}.${HOSTNAME}`;
  const res = await fetch(`http://127.0.0.1:${PDS_PORT}/xrpc/com.atproto.server.createAccount`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, email: `${name}@example.test`, password: `ghostly-${name}` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createAccount ${handle}: ${JSON.stringify(body)}`);
  console.log(`account ${handle} ${body.did}`);
}
console.log(`ready plc=${PLC_PORT} pds=${PDS_PORT} hostname=${HOSTNAME}`);

const stop = async () => { await pds.destroy().catch(() => {}); await plc.destroy().catch(() => {}); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
