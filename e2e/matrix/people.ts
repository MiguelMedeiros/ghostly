import { expect } from "@playwright/test";
import { openDesktop, type DesktopApp } from "../support/desktop";
import { setClipboard } from "../support/clipboard";
import { chatPane, either, go, type Actor } from "./actors";

/**
 * One person in a scenario that has a Desktop peer, whichever client they are on. The browser clients
 * are driven by Playwright (actors.ts); Desktop through WebDriver (support/desktop.ts), which clicks,
 * types and runs a script in the page, and no more. The chat blocks for Desktop scenarios
 * (desktop.ts) go through this, so the same block pairs web with Desktop and Desktop with Desktop.
 */
export interface Person {
  name: string;
  kind: "web" | "extension" | "desktop";
  /** Where this person's chat lives (`#/chat/…`), once there is one. */
  chatHash?: string;
  go(hash: string): Promise<void>;
  /** Clicks a button (or a link) by its text, `title` or `aria-label`, inside `within` when given. */
  press(label: string, within?: string): Promise<void>;
  /** The invite of a new chat, as "Copy invite" puts it on the clipboard. */
  copyInvite(): Promise<string>;
  /** "Join chat", with this text on the clipboard. */
  join(invite: string): Promise<void>;
  /** The message box can be written in: the chat is up. */
  canWrite(): Promise<boolean>;
  hash(): Promise<string>;
  say(text: string): Promise<void>;
  /** Whether the open conversation shows this text. */
  shows(text: string): Promise<boolean>;
  /** Whether one of this person's texts still shows "Sent · waiting for receipt". */
  awaitingReceipt(): Promise<boolean>;
  /** The page's visible text, for the report when something fails. */
  snapshot(): Promise<string>;
  /** The chat header's connection state, as its label says (`Connected · Iroh`). */
  connection(): Promise<string>;
  /**
   * Connection options: prefer one transport, with or without fallback. Returns which transports this
   * client offers at all (the others are disabled there).
   */
  preferTransport(preferred: "WebRTC" | "Iroh" | "HyperDHT" | undefined, fallback: boolean): Promise<string[]>;
  /** Leaves (closes the app or the page) and returns how to come back to the chat. */
  away(): Promise<() => Promise<void>>;
}

/* ---------- the browser clients ---------- */

export function webPerson(actor: Actor): Person {
  const page = () => actor.page;
  const person: Person = {
    name: actor.name,
    kind: actor.kind,
    get chatHash() { return actor.chatHash; },
    set chatHash(hash) { actor.chatHash = hash; },
    go: (hash) => go(actor, hash),
    press: async (label, within) => {
      const scope = within ? page().locator(within) : page();
      await scope.getByRole("button", { name: either(label) }).or(scope.getByTitle(label, { exact: true })).first().click();
    },
    copyInvite: async () => {
      await page().evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (value: string) => { (window as unknown as { qaInvite: string }).qaInvite = value; } },
        });
      });
      await page().getByTestId("invite-card").getByRole("button", { name: either("Copy invite") }).click();
      return page().evaluate(() => (window as unknown as { qaInvite: string }).qaInvite);
    },
    join: async (invite) => {
      await page().getByRole("button", { name: either("Join chat") }).first().click();
      await setClipboard(page(), invite);
      await page().getByRole("button", { name: either("Paste from clipboard") }).click();
    },
    canWrite: () => page().getByPlaceholder("Message…").isEnabled(),
    hash: () => page().evaluate(() => location.hash),
    say: async (text) => {
      const box = page().getByPlaceholder("Message…");
      await expect(box).toBeEnabled({ timeout: 60_000 });
      await box.fill(text);
      await box.press("Enter");
    },
    shows: async (text) => (await chatPane(actor).getByText(text, { exact: true }).count()) > 0,
    awaitingReceipt: async () => (await chatPane(actor).getByText(either("Sent · waiting for receipt")).count()) > 0,
    snapshot: () => page().evaluate(() => document.body.innerText),
    connection: async () => (await page().getByTestId("connection-options").getAttribute("aria-label")) ?? "",
    preferTransport: async (preferred, fallback) => {
      await page().getByTestId("connection-options").click();
      const dialog = page().getByRole("dialog", { name: "Connection options" });
      const offered: string[] = [];
      for (const name of ["WebRTC", "Iroh", "HyperDHT"]) if (await dialog.getByRole("radio", { name, exact: true }).isEnabled()) offered.push(name);
      if (preferred) await dialog.getByRole("radio", { name: preferred, exact: true }).check();
      const toggle = dialog.getByRole("switch", { name: "Fallback" });
      if ((await toggle.isChecked()) !== fallback) await toggle.click();
      await expect(toggle).toBeChecked({ checked: fallback });
      await page().keyboard.press("Escape");
      return offered;
    },
    away: async () => {
      const url = page().url();
      await page().close();
      return async () => {
        actor.page = await actor.context.newPage();
        await actor.page.goto(url);
        await expect(chatPane(actor)).toBeVisible({ timeout: 60_000 });
      };
    },
  };
  return person;
}

/* ---------- Desktop ---------- */

/**
 * Finds a button (or link) by what a person reads on it, its `title` or its `aria-label`, and clicks it;
 * throws with what there was instead. Runs in the page: WebDriver's selectors are CSS only.
 */
const PRESS = `
  const [label, within] = arguments;
  const root = within ? document.querySelector(within) : document;
  if (!root) throw new Error("nothing at " + within);
  const candidates = [...root.querySelectorAll("button, a, [role=button], [role=tab], [role=radio], [role=switch]")];
  const named = (e) => [e.textContent, e.getAttribute("title"), e.getAttribute("aria-label")].some((t) => t && t.trim() === label);
  const target = candidates.find(named);
  if (!target) throw new Error("no button " + JSON.stringify(label));
  target.click();
`;

export interface DesktopPerson extends Person {
  app: DesktopApp;
  stop(): Promise<void>;
}

/** A Desktop app of its own (`home`, `profile`), pointed at the test's relay and HyperDHT bootstrap by `env`. */
export async function desktopPerson(name: string, options: { home: string; env: Record<string, string> }): Promise<DesktopPerson> {
  const open = () => openDesktop({ profile: `matrix-${name}`, home: options.home, env: options.env });
  let session = await open();
  const app = () => session.app;
  const run = <T>(script: string, ...args: unknown[]) => app().execute<T>(script, ...args);
  // The app is up once it has drawn its home.
  const booted = () => expect.poll(() => app().text('[title="New Chat"]'), { timeout: 90_000 }).not.toBeNull();
  await booted();
  const person: DesktopPerson = {
    name,
    kind: "desktop",
    get app() { return app(); },
    go: async (hash) => { await run(`location.hash = arguments[0];`, hash); },
    // Waits for the button like a Playwright click does: the page draws it a moment after the last action.
    press: (label, within) => expect(async () => { await run(PRESS, label, within ?? null); }).toPass({ timeout: 30_000 }),
    copyInvite: async () => {
      await run(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v) => { window.qaInvite = v; } } });`);
      await person.press("Copy invite", '[data-testid="invite-card"]');
      let invite: string | null = null;
      await expect.poll(async () => (invite = await run<string | null>(`return window.qaInvite ?? null;`))).not.toBeNull();
      return invite!;
    },
    join: async (invite) => {
      // Desktop reads the clipboard natively (the host's readClipboardText), out of a page script's reach, and
      // the test does not touch the machine's clipboard: an empty one opens the invite field, typed in instead.
      await person.press("Join chat");
      await person.press("Paste from clipboard");
      const field = 'dialog textarea[placeholder="Paste invite…"]';
      await expect.poll(() => app().text(field), { message: `${name}'s invite field` }).not.toBeNull();
      await app().type(field, invite);
      await person.press("Join chat", "dialog form");
    },
    canWrite: () => run<boolean>(`const box = document.querySelector('[placeholder="Message…"]'); return !!box && !box.disabled;`),
    hash: () => run<string>(`return location.hash;`),
    say: async (text) => {
      await expect.poll(() => person.canWrite(), { timeout: 60_000 }).toBe(true);
      await app().type('[placeholder="Message…"]', `${text}`);
    },
    shows: (text) => run<boolean>(`
      const pane = document.querySelector(".chat-wallpaper");
      return !!pane && [...pane.querySelectorAll("*")].some((e) => e.childElementCount === 0 && e.textContent === arguments[0]);`, text),
    awaitingReceipt: () => run<boolean>(`return (document.querySelector(".chat-wallpaper")?.innerText ?? "").includes("Sent · waiting for receipt");`),
    snapshot: () => run<string>(`return document.body.innerText;`),
    connection: async () => (await app().attribute('[data-testid="connection-options"]', "aria-label")) ?? "",
    preferTransport: async (preferred, fallback) => {
      await app().click('[data-testid="connection-options"]');
      // The radios are transparent inputs over their labels: clicked from the page, as a person's tap lands.
      return run<string[]>(`
        const [preferred, fallback] = arguments;
        const menu = document.querySelector('[data-testid="connection-menu"]') ?? document;
        const offered = ["WebRTC", "Iroh", "HyperDHT"].filter((name) => !menu.querySelector('input[type=radio][aria-label="' + name + '"]')?.disabled);
        if (preferred) menu.querySelector('input[type=radio][aria-label="' + preferred + '"]').click();
        const toggle = menu.querySelector('input[role=switch][aria-label="Fallback"]');
        if (toggle.checked !== fallback) toggle.click();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return offered;`, preferred ?? null, fallback);
    },
    away: async () => {
      const hash = person.chatHash;
      await session.stop();
      return async () => {
        session = await open();
        await booted();
        if (hash) await person.go(hash);
      };
    },
    stop: () => session.stop(),
  };
  return person;
}
