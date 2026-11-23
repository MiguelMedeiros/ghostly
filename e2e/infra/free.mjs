// Whether this machine has room for `npm run e2e:full`'s own stack: no other checkout's ghostly-e2e stack running
// (the container names are fixed, so `down` would remove it under that checkout's tests), and none of the ports the
// stack publishes held by anything else (`up` would fail at once: "address already in use").
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { PROJECT } from "./env.mjs";

/** The ports of `ports` that cannot be listened on at `host` just now. */
export async function heldPorts(ports, host = "127.0.0.1") {
  const held = await Promise.all(ports.map((port) => new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(port));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(null)));
  })));
  return held.filter((port) => port !== null);
}

/** The running containers of PROJECT started from another checkout than `dir` (Compose's working-dir label), as "name (dir)". */
export function otherStacks(dir, env = process.env) {
  const found = spawnSync("docker", ["ps", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--format", '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}'], { env, encoding: "utf8" });
  if (found.status !== 0) return [];
  return found.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter(([, from]) => from !== dir).map(([name, from]) => `${name} (${from || "no checkout"})`);
}

/**
 * Waits, up to `timeoutMs`, until no other stack runs, then takes this checkout's own leftovers down (`down`, once),
 * then waits until no port is held. Returns null once there is room, or why it gave up.
 */
export async function waitForRoom({ others, held, down, log, timeoutMs = 20 * 60_000, every = 15_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  let downed = false, said = "";
  for (;;) {
    const stacks = others();
    if (!stacks.length && !downed) { await down(); downed = true; }
    const ports = stacks.length ? [] : await held();
    if (!stacks.length && !ports.length) return null;
    const why = stacks.length ? `another ${PROJECT} stack runs: ${stacks.slice(0, 3).join(", ")}${stacks.length > 3 ? ` and ${stacks.length - 3} more` : ""}` : `127.0.0.1:${ports.join(",")} held by something else`;
    if (now() >= deadline) return `gave up after ${Math.round(timeoutMs / 60_000)} min waiting for room: ${why}`;
    if (why !== said) { log(`waiting (up to ${Math.round(timeoutMs / 60_000)} min): ${why}`); said = why; }
    await sleep(every);
  }
}
