import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprints as fpr, hasGpg, TestGpg } from "./helpers/gpg";
// covers: proofs.openpgp

/**
 * The gpg the tests sign with (helpers/gpg.ts) is called synchronously. Here a `gpg` first on the PATH stops
 * answering when it is asked to sign, as one waiting on a dead agent does, and is the real one for everything else.
 */
describe.skipIf(!hasGpg || process.platform === "win32")("the tests' gpg, when gpg stops answering", () => {
  let bin: string;
  let gpg: TestGpg | undefined;
  /** `times`: how many signatures in a row get no answer. */
  function stall(times: number) {
    const real = execFileSync("sh", ["-c", "command -v gpg"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "gpg"), `#!/bin/sh
case " $* " in *" --clearsign "*)
  n=$(ls "${bin}" | wc -l)
  if [ "$n" -le ${times} ]; then : > "${bin}/stalled-$n"; exec sleep 60; fi;;
esac
exec "${real}" "$@"
`);
    chmodSync(join(bin, "gpg"), 0o755);
  }
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "ghostly-test-gpg-bin-"));
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  });
  afterEach(() => {
    gpg?.close();
    gpg = undefined;
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  it("asks again, and signs", () => {
    stall(1);
    gpg = new TestGpg(["alice"], { stuckAfter: 1_000 });
    const started = Date.now();
    expect(gpg.clearsign(fpr.alice, "Signed on the second try")).toContain("-----BEGIN PGP SIGNATURE-----");
    expect(existsSync(join(bin, "stalled-1"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("gives up after three tries, and says which command got no answer", () => {
    stall(3);
    gpg = new TestGpg(["alice"], { stuckAfter: 500 });
    const started = Date.now();
    expect(() => gpg!.clearsign(fpr.alice, "Never signed")).toThrow(/^gpg --local-user \S+ --clearsign .* did not answer within 500 ms, 3 times over/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
