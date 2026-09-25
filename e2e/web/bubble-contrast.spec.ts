import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { strangerInvoice } from "../support/bolt11";
import { chat, expect, openChat, openWallet, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Message bubbles take their colours from the theme: a sent and a received bubble in every colour theme, light
 * and dark, with everything in them readable — text, links, the peer's name, timestamps and ticks, files, voice
 * messages, invoices and payment requests. Contrast is measured on the page as drawn (WCAG 2 ratios): the words
 * someone wrote at 4.5:1, everything else in a bubble (names, small print, buttons, ticks, the waveform) at 3:1.
 */

const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${SAMPLE}`],
  },
});

/** Payment requests need a Cashu mint; the rest of the test runs without one. */
const localMint = () => process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:") ?? false;

const SCHEMES = ["dark", "light"] as const;
const COLOR_THEMES = ["classic", "cyan", "purple", "monochrome"] as const;

/** Holds the mic long enough for a short recording. */
async function recordVoice(page: Page) {
  const box = (await page.getByTestId("voice-record").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(1_500);
  await page.mouse.up();
}

async function testnetMint(p: Peer) {
  await openWallet(p, "cashu");
  await p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(p.page.getByTestId("wallet-balance")).toBeVisible();
}

/**
 * The theme as Settings sets it (see ThemeContext; settings.spec.ts drives Settings itself): the attributes are all
 * the stylesheet reads. Resolves once the colour transitions it started have run, so nothing is measured halfway.
 */
async function theme(page: Page, scheme: string, colorTheme: string) {
  await page.evaluate(async ([scheme, colorTheme]) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.setAttribute("data-color-theme", colorTheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
  }, [scheme, colorTheme]);
}

interface Reading { what: string; ratio: number; min: number }

/**
 * Every piece of text in the chat's bubbles, and the icons and bars that carry meaning, against what is behind it:
 * the bubble, and whatever backgrounds sit between it and the element. Colours are resolved by a canvas, so
 * `color-mix()`, `oklab()` and alpha all count as the browser draws them.
 */
function readings(page: Page): Promise<Reading[]> {
  return chat({ page } as Peer).evaluate((root) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    type RGBA = [number, number, number, number];
    const parse = (css: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: RGBA, below: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3])).concat(1) as RGBA;
    const luminance = ([r, g, b]: RGBA) => {
      const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const backdrop = (bubble: HTMLElement, el: Element): RGBA => {
      const chain: Element[] = [];
      for (let at: Element | null = el; at && at !== bubble; at = at.parentElement) chain.unshift(at);
      let bg = parse(getComputedStyle(bubble).backgroundColor);
      for (const at of chain) {
        const own = parse(getComputedStyle(at).backgroundColor);
        if (own[3] > 0) bg = over(own, bg);
      }
      return bg;
    };
    const label = (el: Element) => {
      const id = el.closest("[data-testid]")?.getAttribute("data-testid") ?? "bubble";
      return `${id} › ${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 32)}"`;
    };
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const body = "[data-testid=message-text], [data-testid=message-text] a, [data-testid=file-bubble] p[title]";
    const out: { what: string; ratio: number; min: number }[] = [];
    for (const bubble of root.querySelectorAll<HTMLElement>("[data-message-bubble]")) {
      const side = bubble.closest("[data-message-row]")?.getAttribute("data-sender") ?? "?";
      const bubbleBg = parse(getComputedStyle(bubble).backgroundColor);
      if (bubbleBg[3] < 1) out.push({ what: `${side} bubble background is not opaque`, ratio: 0, min: 1 });
      for (const el of bubble.querySelectorAll("*")) {
        // Not on the bubble: the QR code's white card, a picture and the chip over it, a select field (its own surface).
        if (!visible(el) || el.closest("button[title='Hide the QR code'], img, [data-picture-time], [role=combobox]")) continue;
        const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(n.textContent ?? ""));
        const icon = el.matches(".msg-meta svg, .voice-wave-base .voice-wave-bar");
        if (!text && !icon) continue;
        const style = getComputedStyle(el);
        // A bar is drawn in its background colour: what is behind it starts at its parent.
        const bar = icon && el.matches(".voice-wave-bar");
        const ink = bar ? style.backgroundColor : style.color;
        const bg = backdrop(bubble, bar ? el.parentElement! : el);
        out.push({ what: `${side}: ${label(el)}`, ratio: Math.round(ratio(over(parse(ink), bg), bg) * 100) / 100, min: text && el.matches(body) ? 4.5 : 3 });
      }
    }
    return out;
  });
}

test("message bubbles follow the theme, and what is in them stays readable in every theme", { tag: ["@feature:app.theme.bubbles"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("bubbles-alice", { viewport: { width: 1100, height: 1500 } }), peer("bubbles-bob", { viewport: { width: 1100, height: 1500 } })]);
  await pair(alice, bob);

  // Text, a link, a file and a voice message each way, an invoice pasted as text, and a payment request.
  await say(bob, "Received text: dinner at eight?");
  await expect(chat(alice).getByText("Received text: dinner at eight?")).toBeVisible();
  await say(alice, "Sent text: see https://ghostly.tools/menu first");
  await expect(chat(bob).getByText(/Sent text: see/)).toBeVisible();
  await bob.page.getByTestId("file-input").setInputFiles({ name: "menu from bob.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(2048, 1) });
  await alice.page.getByTestId("file-input").setInputFiles({ name: "notes from alice.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024, 65) });
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("file-save")).toHaveCount(2, { timeout: 30_000 });
  await recordVoice(bob.page);
  await recordVoice(alice.page);
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("voice-play").and(p.page.locator(":enabled"))).toHaveCount(2, { timeout: 30_000 });
  await say(bob, `pay me ${strangerInvoice(2100, "bubble colours")}`);
  for (const p of [alice, bob]) {
    const card = chat(p).getByTestId("invoice-bubble");
    await expect(card).toBeVisible();
    await card.getByTitle("Hide the QR code").click();
  }
  if (localMint()) {
    for (const p of [alice, bob]) await testnetMint(p);
    for (const p of [alice, bob]) await openChat(p);
    await bob.page.getByTestId("payment-button").click();
    await bob.page.getByTestId("payment-card-cashu").click();
    await bob.page.getByTestId("payment-amount").fill("12");
    await bob.page.getByTestId("payment-composer").getByPlaceholder("What for? (optional)").fill("half the pizza");
    await bob.page.getByTestId("payment-request").click();
    for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble")).toContainText("half the pizza");
  }

  const failures = new Set<string>();
  for (const colorTheme of COLOR_THEMES) {
    for (const scheme of SCHEMES) {
      for (const p of [alice, bob]) {
        await theme(p.page, scheme, colorTheme);
        const sent = await chat(p).locator("[data-message-row][data-sender=me] [data-message-bubble]").first().evaluate((el) => getComputedStyle(el).backgroundColor);
        const received = await chat(p).locator("[data-message-row][data-sender=peer] [data-message-bubble]").first().evaluate((el) => getComputedStyle(el).backgroundColor);
        const expected = await p.page.evaluate(() => {
          const css = getComputedStyle(document.documentElement);
          const resolve = (v: string) => {
            const probe = document.createElement("span");
            probe.style.color = css.getPropertyValue(v);
            document.body.append(probe);
            const out = getComputedStyle(probe).color;
            probe.remove();
            return out;
          };
          return [resolve("--theme-sent-bg"), resolve("--theme-received-bg")];
        });
        expect.soft([sent, received], `${colorTheme} ${scheme}: bubbles use the theme's sent and received colours`).toEqual(expected);
        const measured = await readings(p.page);
        // Nothing passes by being left out: each kind of bubble was measured.
        const kinds = ["message-text", "file-bubble", "voice-waveform", "invoice-bubble", ...(localMint() ? ["payment-bubble"] : [])];
        for (const kind of kinds) expect(measured.some((r) => r.what.includes(`${kind} ›`)), `${kind} measured`).toBe(true);
        for (const r of measured) {
          if (r.ratio < r.min) failures.add(`${colorTheme} ${scheme} (${p.name}) ${r.what}: ${r.ratio}:1 < ${r.min}:1`);
        }
        if (colorTheme === "classic" || colorTheme === "cyan") {
          await p.page.mouse.move(1, 1);
          const path = testInfo.outputPath(`${p.name.replace("bubbles-", "")}-${colorTheme}-${scheme}.png`);
          await chat(p).screenshot({ path });
          await testInfo.attach(`${p.name} ${colorTheme} ${scheme}`, { path, contentType: "image/png" });
        }
      }
    }
  }
  expect([...failures], [...failures].join("\n")).toEqual([]);
});
