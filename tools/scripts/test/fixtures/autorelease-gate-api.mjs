// Loaded with `node --import` before tools/scripts/autorelease-gate.mjs in its tests: answers the GitHub API from the
// fixture in $GATE_FIXTURE (the branch, its compares with main and dev, file contents on main and on the branch) and makes the
// gate's 30 s waits instant. tools/scripts/test/autoreleaseGate.ts writes the fixture.
import { readFileSync } from "node:fs";

const SHARED = "b".repeat(40);
const fixture = JSON.parse(readFileSync(process.env.GATE_FIXTURE, "utf8"));
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => realTimeout(fn, 0, ...args);

globalThis.fetch = async (url) => {
  const { pathname, searchParams } = new URL(url);
  const path = pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
  const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  if (path.startsWith("/branches/")) return reply(200, { commit: { sha: fixture.sha } });
  // The newest commit the branch shares with dev, and how far that one is ahead of main.
  if (path.startsWith("/compare/dev...")) return reply(200, { merge_base_commit: { sha: SHARED } });
  if (path === `/compare/main...${SHARED}`) return reply(200, { ahead_by: fixture.unreleased ?? 0, behind_by: 0, files: [] });
  if (path.startsWith("/compare/")) return reply(200, { behind_by: 0, files: fixture.files });
  if (path.startsWith("/contents/")) {
    const content = fixture[searchParams.get("ref") === "main" ? "main" : "branch"][decodeURIComponent(path.slice("/contents/".length))];
    if (content === undefined) return reply(404, { message: "Not Found" });
    return reply(200, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  if (path.startsWith("/git/ref/tags/")) return reply(404, { message: "Not Found" });
  if (path.startsWith("/releases")) return reply(200, []);
  if (path.startsWith("/actions/workflows/security.yml/runs")) return reply(200, { workflow_runs: [{ status: "completed", conclusion: "success" }] });
  return reply(500, { message: `not in the fake API: ${path}` });
};
