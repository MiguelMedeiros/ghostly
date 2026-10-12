import chess from "../../assets/apps/chess.ghostlyapp?url";

/*
 * The bundles this build carries for the apps that come with Ghostly (WISP 1200 § Built-in apps), by the digest the
 * engine's list pins (`BUILT_IN_APPS`, packages/browser/src/engine/appDefaults.ts). Each is the file its publisher
 * signed, as the store serves it: a file of this client (a hashed asset of the web app, a file of the Desktop
 * application), read from the client's own origin and nowhere else, when the person first opens the app. The engine
 * checks what it gets whole, against the pinned digest: a wrong file here is no app, never another one.
 *
 * To carry another version: put the publisher's `app.ghostlyapp` in src/assets/apps/, and its digest here and in
 * `BUILT_IN_APPS` (`npm run test -w @ghostly/ui -- builtInApps` says when the two differ).
 */
const CARRIED: ReadonlyMap<string, string> = new Map([
  ["EEnFmP0grTkTe_9qgapQsEEZzWB9FcpoimWkHnfecVs", chess],
]);

/** The engine's `builtInApp`: the carried bundle of this digest, from this client's own files. */
export async function readBuiltInApp(app: { digest: string }): Promise<Uint8Array> {
  const url = CARRIED.get(app.digest);
  if (!url) throw new Error("This build does not carry this app");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`This build's copy of the app did not load (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
