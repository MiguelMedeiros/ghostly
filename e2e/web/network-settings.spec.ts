import type { BrowserContext, Page } from "@playwright/test";
import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

const DEFAULT_RELAYS = "https://pkarr.pubky.org\nhttps://pkarr.pubky.app\nhttps://pkarr.miguelmedeiros.dev";

/** The network section of Settings: relays, TURN address, username and credential. */
function network(page: Page) {
  return {
    relays: page.getByTestId("network-relays"),
    turnUrl: page.getByPlaceholder("turn:turn.example.org:3478"),
    turnUser: page.getByPlaceholder("Username"),
    turnCredential: page.getByPlaceholder("Credential"),
    save: page.getByTestId("network-save"),
    reset: page.getByRole("button", { name: "Reset to defaults" }),
  };
}

async function save(page: Page): Promise<void> {
  await network(page).save.click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

/** Nothing here may leave the machine: relays typed into the form are answered locally. */
async function keepOffline(peer: Peer): Promise<void> {
  await peer.context.route(/^https?:\/\/relay\.example\.org\//, (route) => route.abort());
}

/** Every WebRTC connection the page makes, in order: its configuration and the candidates it gathered. */
type Connection = { policy?: string; urls: string[]; candidates: string[] };

/** Keeps `window.connections` (`Connection`) for every peer connection this context's pages make. Before they open. */
async function recordConnections(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const connections: { policy?: string; urls: string[]; candidates: string[] }[] = [];
    (window as unknown as { connections: typeof connections }).connections = connections;
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        const seen = { policy: config?.iceTransportPolicy, urls: (config?.iceServers ?? []).flatMap((server) => [server.urls].flat()), candidates: [] as string[] };
        connections.push(seen);
        this.addEventListener("icecandidate", (event) => { if (event.candidate?.candidate) seen.candidates.push(event.candidate.candidate); });
      }
    };
  });
}

test("Hide my IP from contacts needs a TURN server, is kept across a reload, and keeps its server while on", { tag: ["@feature:settings.network.relay-only", "@feature:settings.network.turn"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings/network");
  const form = network(page);
  const relayOnly = page.getByTestId("network-relay-only");
  await expect(relayOnly).toHaveAttribute("aria-checked", "false");

  // Without a TURN server it stays off, and says what to do first.
  await relayOnly.click();
  await expect(page.getByRole("alert")).toHaveText("Add a TURN server first. Save one above, then turn this on.");
  await expect(relayOnly).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(relayOnly).toHaveAttribute("aria-checked", "false");

  await form.turnUrl.fill("turn:turn.example.org:3478");
  await form.turnUser.fill("ghost");
  await form.turnCredential.fill("s3cret-boo");
  await save(page);
  await relayOnly.click();
  await expect(relayOnly).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(relayOnly).toHaveAttribute("aria-checked", "true");

  // The server it goes through is not taken away while it is on: said under its address.
  await form.turnUrl.fill("");
  await form.save.click();
  await expect(form.turnUrl).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("network-turn-field")).toContainText("Hide my IP needs this TURN server. Turn it off first, then remove the server.");
  await page.reload();
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");

  await relayOnly.click();
  await expect(relayOnly).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(relayOnly).toHaveAttribute("aria-checked", "false");
});

/**
 * With it on, every connection to a contact goes through the TURN server alone, and one that does not answer (a closed
 * port here) leaves nothing to connect with: no STUN server asked, no address of this machine handed out, the chat on
 * the DHT, where a text still arrives. Turned off, the chat is live again.
 */
test("with Hide my IP from contacts on, a contact's connections use the TURN server alone and fail closed", { tag: ["@feature:settings.network.relay-only", "@feature:chat.paired.send"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("relay-only-alice", { beforeOpen: recordConnections }), peer("relay-only-bob")]);
  await pair(alice, bob);
  const page = alice.page;
  const chatRoute = new URL(page.url()).hash;
  const connections = () => page.evaluate(() => (window as unknown as { connections: Connection[] }).connections.map((c) => ({ ...c, candidates: [...c.candidates] })));
  const direct = await connections();
  // Before: the app's STUN servers, and this machine's own addresses (the pairing went direct).
  expect(direct.some((c) => c.urls.some((url) => /^stun:/.test(url)))).toBe(true);
  expect(direct.some((c) => c.candidates.some((candidate) => / typ host /.test(candidate)))).toBe(true);

  // Hash routes: the page (and its record) stays.
  await page.goto("/#/settings/network");
  const form = network(page);
  await form.turnUrl.fill("turn:127.0.0.1:9");
  await form.turnUser.fill("ghost");
  await form.turnCredential.fill("s3cret-boo");
  await save(page);
  const before = (await connections()).length;
  await page.getByTestId("network-relay-only").click();
  await expect(page.getByTestId("network-relay-only")).toHaveAttribute("aria-checked", "true");

  await page.goto(`/${chatRoute}`);
  await expect(page.getByTestId("connection-options")).not.toHaveAccessibleName(/Connected · /, { timeout: 30_000 });
  await page.getByPlaceholder("Message…").fill("through the DHT");
  await page.getByPlaceholder("Message…").press("Enter");
  await expect(chat(bob).getByText("through the DHT")).toBeVisible({ timeout: 90_000 });
  // The chat tries again meanwhile (its own offers, and bob's answered): every one through the relay alone.
  await expect.poll(async () => (await connections()).length - before, { timeout: 60_000 }).toBeGreaterThan(0);
  const relayed = (await connections()).slice(before);
  for (const c of relayed) {
    expect(c.policy).toBe("relay");
    expect(c.urls).toEqual(["turn:127.0.0.1:9"]);
    expect(c.candidates.filter((candidate) => !/ typ relay /.test(candidate))).toEqual([]);
  }
  await expect(page.getByTestId("connection-options")).not.toHaveAccessibleName(/Connected · /);

  await page.goto("/#/settings/network");
  await page.getByTestId("network-relay-only").click();
  await expect(page.getByTestId("network-relay-only")).toHaveAttribute("aria-checked", "false");
  await page.goto(`/${chatRoute}`);
  await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
});

test("a TURN server is kept across a reload, and removed by clearing its address",{ tag: ["@feature:settings.network.turn", "@feature:settings.network.relays"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings/network");
  const form = network(page);
  await expect(form.turnUrl).toHaveValue("");
  // The credential is a secret: typed into a password field.
  await expect(form.turnCredential).toHaveAttribute("type", "password");

  await form.turnUrl.fill("  turn:turn.example.org:3478  ");
  await form.turnUser.fill("ghost");
  await form.turnCredential.fill("s3cret-boo");
  await save(page);

  await page.reload();
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");
  await expect(form.turnUser).toHaveValue("ghost");
  await expect(form.turnCredential).toHaveValue("s3cret-boo");
  // Setting a TURN server leaves the relays alone.
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);

  // "Reset to defaults" belongs to the relay list: it restores the relays, not the TURN server.
  await form.relays.fill("https://relay.example.org");
  await form.reset.click();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");

  // No address, no TURN server: username and credential go with it.
  await form.turnUrl.fill("");
  await save(page);
  await page.reload();
  await expect(form.turnUrl).toHaveValue("");
  await expect(form.turnUser).toHaveValue("");
  await expect(form.turnCredential).toHaveValue("");
});

test("relays: only http(s) addresses are kept, normalized and without duplicates", { tag: ["@feature:settings.network.relays"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await keepOffline(alice);
  const { page } = alice;
  await page.goto("/#/settings/network");
  const form = network(page);
  // A line that is not an http(s) relay, next to ones that are: the list is refused whole, nothing is saved (#4539).
  await form.relays.fill(
    [
      "javascript:alert(1)",
      "ftp://relay.example.org",
      "file:///etc/passwd",
      "data:text/plain,relay",
      "https://relay.example.org/pkarr/",
      "https://relay.example.org/pkarr",
    ].join("\n"),
  );
  await form.save.click();
  await expect(form.relays).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
  // The good lines alone: kept normalized and without duplicates.
  await form.relays.fill(["https://relay.example.org/pkarr/", "https://relay.example.org/pkarr"].join("\n"));
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue("https://relay.example.org/pkarr");

  await form.reset.click();
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
});

// A list with nothing usable in it would leave this browser unable to reach anyone: refused.
test("relays: a list with no valid address is refused, and the relays stay", { tag: ["@feature:settings.network.relays"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await keepOffline(alice);
  const { page } = alice;
  await page.goto("/#/settings/network");
  const form = network(page);
  await form.relays.fill("not a url\njavascript:alert(1)");
  await form.save.click();
  await expect(page.getByTestId("network-error")).toContainText("at least one relay");
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(form.relays).not.toHaveValue("");
});

// A TURN address WebRTC refuses would make every connection of this browser fail: the form says
// why and keeps the old setting.
test("a TURN address WebRTC cannot use is refused, and chats still connect", { tag: ["@feature:settings.network.turn", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await alice.page.goto("/#/settings/network");
  const form = network(alice.page);
  for (const [urls, user, credential, problem] of [
    ["turn:turn.example.org:3478", "", "", "username and credential"],
    ["turn.example.org:3478", "u", "c", "not a TURN or STUN address"],
    ["https://turn.example.org", "u", "c", "not a TURN or STUN address"],
  ] as const) {
    await form.turnUrl.fill(urls);
    await form.turnUser.fill(user);
    await form.turnCredential.fill(credential);
    await form.save.click();
    await expect(alice.page.getByTestId("network-error"), urls).toContainText(problem);
  }
  await alice.page.reload();
  await expect(form.turnUrl).toHaveValue("");
  await alice.page.goto("/#/");
  await link(alice, bob);
  await connect(alice, bob);
  await expect(chat(bob).getByText("hello from alice")).toBeVisible();
});
