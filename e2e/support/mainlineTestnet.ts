import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * A Mainline DHT of a few nodes on 127.0.0.1 (cli/examples/mainline_testnet.rs, the same `mainline` crate the
 * Desktop runs), for Desktop apps started with GHOSTLY_PKARR_DHT_BOOTSTRAP: they read and publish on it as they
 * would on the real DHT, and nothing leaves the machine. The first run compiles the example (cargo).
 */
export async function mainlineTestnet(nodes = 8): Promise<{ bootstrap: string; close: () => void }> {
  const child = spawn("cargo", ["run", "--quiet", "--manifest-path", join(ROOT, "cli", "Cargo.toml"), "--example", "mainline_testnet", "--", String(nodes)], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const bootstrap = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n")) resolve(line.trim());
    });
    child.once("exit", (code) => reject(new Error(`mainline_testnet exited (${code}) before it printed its nodes`)));
    child.once("error", reject);
  });
  // It runs until its standard input closes.
  return { bootstrap, close: () => { child.stdin.end(); child.kill(); } };
}
