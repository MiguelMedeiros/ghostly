import { VERSION } from "@/lib/release";

/**
 * What the newest published release is, for a client asking whether it is out
 * of date. Ghostly serves this itself so that no client has to ask a third
 * party, and any origin may read it: the extension asks from its own.
 *
 * `scripts/bump-version.mjs` sets the version this answers with, and the site
 * is rebuilt as part of every release.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify({ version: VERSION }) + "\n", {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
