/*
 * The bundles this build carries for the apps that come with Ghostly (WISP 1200 § Built-in apps): each is the file its
 * publisher signed, read from the app's own repository when the build is made (scripts/built-in-apps.mjs, pinned by
 * digest in src/assets/apps/built-in.json) and never kept in this repository. The build makes each a file of the
 * client (a hashed asset of the web app, a file of the Desktop application), read from the client's own origin and
 * nowhere else, when the person first opens the app. The engine checks what it gets whole, against the digest its own
 * list pins: a wrong file here is no app, never another one. A build made without a file offers no such app.
 */
const files = import.meta.glob<string>("../../assets/apps/*.ghostlyapp", { eager: true, query: "?url", import: "default" });
/** By app name: the file is src/assets/apps/<name>.ghostlyapp. */
const CARRIED: ReadonlyMap<string, string> = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".ghostlyapp".length), url]));

/**
 * What a host gives its engine (`NodeOptions.builtInApp`). In the e2e suite's build (VITE_APPS_TEST, fixed when the
 * build is made) built-in apps are off, so the specs written for an empty Apps page and for the suite's own test-signed
 * Chess see what they expect; a spec about built-in apps sets `localStorage["ghostly-test-built-in-apps"] = "on"` before
 * the page loads. Read once.
 */
export function builtInAppOption(): { builtInApp?: typeof readBuiltInApp } {
  if (import.meta.env.VITE_APPS_TEST === "1") {
    try { if (localStorage.getItem("ghostly-test-built-in-apps") !== "on") return {}; } catch { return {}; }
  }
  return { builtInApp: readBuiltInApp };
}

/** The engine's `builtInApp`: the carried bundle of this app, from this client's own files. */
export async function readBuiltInApp(app: { name: string }): Promise<Uint8Array> {
  const url = CARRIED.get(app.name);
  if (!url) throw new Error("This build does not carry this app");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`This build's copy of the app did not load (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
