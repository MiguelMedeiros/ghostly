// Per-revive node_modules/@ghostly links pointing into that revive tree (the session tree's would be found otherwise).
import { mkdirSync, readlinkSync, readdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scoped = join(root, "node_modules/@ghostly");
for (const pr of process.argv.slice(2)) {
  const dir = join(root, ".revive", pr, "node_modules/@ghostly");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(scoped)) {
    if (!existsSync(join(dir, name))) symlinkSync(readlinkSync(join(scoped, name)), join(dir, name));
  }
  console.log(pr, readdirSync(dir).join(" "));
}
