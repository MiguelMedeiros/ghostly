import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";

// The e2e stack's group-call pair (WISP 602): a LiveKit SFU and the mock of a node's token route. Two members of a
// group ask the mock for a pass with signed requests, join the group's room from two Chromium pages, and each sees
// the other's camera (Chromium's fake one). No app here: this holds the stack the group-call suites build on.
test.skip(!process.env.GHOSTLY_SFU_URL, "Needs the e2e infra's LiveKit and group-token mock (npm run e2e:infra:use)");

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
/** A member's key as WISP 602 spells it: z-base32 of the 32 public key bytes, 52 characters. */
function member(): { k: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let bits = BigInt(`0x${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`) << 4n;
  let k = "";
  for (let i = 0; i < 52; i++, bits >>= 5n) k = ZBASE32[Number(bits & 31n)] + k;
  return { k, key: privateKey };
}

/** A pass from the mock for `k`'s group call, by a signed token request. */
async function pass(g: string, { k, key }: ReturnType<typeof member>, name: string) {
  const body = { v: 1, g, k, room: `g_${g}`, ts: Math.floor(Date.now() / 1000), n: randomBytes(16).toString("base64url") };
  const signed = Buffer.from(JSON.stringify(["ghostly-sfu/1 token", endpoints.sfu.origin, g, body.room, k, body.ts, body.n]));
  const res = await fetch(`${endpoints.sfu.token}/sfu/group-token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, name, sig: sign(null, signed, key).toString("base64url") }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { url: string; token: string; room: string; identity: string };
}

/** The other member's camera plays on `page`: a picture with a size, and its time moving on. */
async function seesCamera(page: Page, identity: string) {
  const video = page.locator(`video[data-identity="${identity}"]`);
  await expect(video).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  const at = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(at);
}

test("two members join their group's room with passes from the token mock and see each other's camera", async ({ browser }) => {
  const g = randomBytes(16).toString("base64url");
  const [ana, bia] = [member(), member()];
  // The group's roster, as the node would know it from the membership chain.
  const roster = await fetch(`${endpoints.sfu.token}/test/roster/${g}`, { method: "PUT", body: JSON.stringify({ [ana.k]: "Ana", [bia.k]: "Bia" }) });
  expect(roster.status).toBe(204);

  const pages = await Promise.all([ana, bia].map(async () => (await browser.newContext()).newPage()));
  for (const [page, who, name] of [[pages[0], ana, "Ana"], [pages[1], bia, "Bia"]] as const) {
    const { url, token, room, identity } = await pass(g, who, name);
    expect({ url, room, identity }).toEqual({ url: endpoints.sfu.livekit, room: `g_${g}`, identity: who.k });
    await page.goto(`${endpoints.sfu.token}/smoke`);
    await page.evaluate(([u, t]) => (window as unknown as { joinCall(u: string, t: string): Promise<void> }).joinCall(u, t), [url, token]);
  }
  await seesCamera(pages[0], bia.k);
  await seesCamera(pages[1], ana.k);
  await Promise.all(pages.map((page) => page.context().close()));
});
