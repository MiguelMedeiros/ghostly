/**
 * Every answer of the site says `no-transform` (Cache-Control), so the proxy in front of it (Cloudflare) writes nothing
 * into its pages: its Web Analytics setup put a beacon `<script>` into every page. The script policy refused it
 * (next.config.ts), but each visit still logged a console error and a failed request on a site with no analytics.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ ServerResponse }, { withNoTransform }] = await Promise.all([import("node:http"), import("./lib/noTransform")]);
  withNoTransform(ServerResponse);
}
