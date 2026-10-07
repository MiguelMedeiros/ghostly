/**
 * VITE_APPS_TEST=1 makes the e2e suite's build: mini-apps on in the engine (apps/web/src/host.ts) and the test hook
 * that runs one through the real runner and broker (apps/ui/src/lib/apps/testHook.ts). It is read when the build is
 * made, never at runtime. Only "1" or nothing; and never in an image build (GHOSTLY_BUILD, which is what gets deployed:
 * apps/web/Dockerfile also empties it).
 */
export function checkAppsTestFlag(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.VITE_APPS_TEST;
  if (flag === undefined || flag === "") return false;
  if (flag !== "1") throw new Error(`VITE_APPS_TEST is "1" or unset, not ${JSON.stringify(flag)}`);
  if (env.GHOSTLY_BUILD) throw new Error("VITE_APPS_TEST is for the e2e suite's build: an image build (GHOSTLY_BUILD) must not carry it");
  return true;
}
