import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * A crate that implements a COM interface of the `windows` crate (wmi's event sink, under iroh's netwatch) needs the
 * very windows-core that `windows` was built on: with another one, `#[implement]` fails on Windows only, "the trait
 * bound IWbemObjectSink: windows_core::Interface is not satisfied" (E0277). wmi asks for each in a range
 * (`>=0.59, <0.63`), which cargo resolves one at a time, and Dependabot's cargo group once left wmi on windows 0.62
 * with windows-core 0.61: Linux and macOS built, the Windows Desktop did not. This holds every lockfile to the pair.
 */
const root = resolve(import.meta.dirname, "../../..");

const LOCKS = ["Cargo.lock", "native/transports/iroh-web/Cargo.lock"];

type Package = { name: string; version: string; dependencies: string[] };

function packages(lock: string): Package[] {
  return readFileSync(join(root, lock), "utf8").split("\n[[package]]\n").slice(1).map((block) => ({
    name: block.match(/^name = "(.+)"$/m)![1],
    version: block.match(/^version = "(.+)"$/m)![1],
    dependencies: [...(block.match(/^dependencies = \[\n([\s\S]*?)\n\]/m)?.[1] ?? "").matchAll(/^ "(.+)",$/gm)].map((line) => line[1]),
  }));
}

/** The version of `name` a package depends on: spelled out when the lockfile has several, else the only one. */
function resolved(all: Package[], dependencies: string[], name: string): string | undefined {
  const entry = dependencies.find((dependency) => dependency === name || dependency.startsWith(`${name} `));
  if (!entry) return undefined;
  return entry.split(" ")[1] ?? all.find((p) => p.name === name)!.version;
}

it("every crate on both windows and windows-core takes the windows-core its windows was built on", () => {
  const mismatched = LOCKS.flatMap((lock) => {
    const all = packages(lock);
    return all.flatMap(({ name, version, dependencies }) => {
      const windows = resolved(all, dependencies, "windows");
      const core = resolved(all, dependencies, "windows-core");
      if (!windows || !core) return [];
      const built = all.find((p) => p.name === "windows" && p.version === windows)!;
      const wanted = resolved(all, built.dependencies, "windows-core");
      return wanted === core ? [] : [`${lock}: ${name} ${version} takes windows ${windows} (on windows-core ${wanted}) with windows-core ${core}`];
    });
  });
  expect(mismatched).toEqual([]);
});

it("reads the lockfile's pairs (the check above is not empty)", () => {
  const wmi = packages("Cargo.lock").find((p) => p.name === "wmi");
  expect(wmi?.dependencies.some((d) => d.startsWith("windows-core"))).toBe(true);
});
