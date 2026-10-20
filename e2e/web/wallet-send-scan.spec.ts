import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import type { Page } from "@playwright/test";
import { expect, getTestCoins, openWallet, test, useTestnet } from "../support/fixtures";
import { strangerInvoice } from "../support/bolt11";
import { LocalLnurlServer } from "../support/lnurl";
import { endpoints } from "../infra/env.mjs";

/**
 * Send on the Lightning and Cashu cards, as a phone wallet: a QR read from a picture (Choose image; the camera reads
 * frames the same way) goes to its review, then Pay. Sats move through the test mint (`E2E_MINT_URL` answers for the
 * public one when set, see support/mint.ts), worthless. The invoice is a stranger's (support/bolt11.ts): a test mint
 * marks its own invoices paid by itself, so paying one of those proves nothing. The Lightning address is served by a
 * server of this test's own (support/lnurl.ts); its invoices are the mint's, so it is paid only against the suite's own
 * mint (`E2E_MINT_URL`), which settles them inside, and the public one refuses them as already paid.
 */

/** A PNG of `text`'s QR, as a screenshot of one would be: drawn by the app's own QR component, on a blank page. */
async function qrPicture(page: Page, text: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: text, size: 360, marginSize: 4 }));
  const blank = await page.context().newPage();
  try {
    await blank.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    return { name: "qr.png", mimeType: "image/png", buffer: await blank.locator("svg").screenshot() };
  } finally { await blank.close(); }
}

test.describe("Send scans a QR", () => {
  test.describe.configure({ retries: 2 });

  test("an invoice's QR, chosen as a picture, opens its review and is paid", { tag: ["@feature:wallet.cashu.send-scan", "@feature:wallet.cashu.pay-invoice"] }, async ({ peer }) => {
    const alice = await peer("alice");
    await useTestnet(alice);
    await getTestCoins(alice);
    const invoice = strangerInvoice(13, "Scanned coffee", "lntb");
    const page = alice.page;

    await page.getByTestId("wallet-send").click();
    await expect(page.getByTestId("wallet-send-camera")).toBeVisible();
    await expect(page.getByText("Paying a contact? Use ⚡ in the chat.")).toBeVisible();
    // A QR's text is often upper case, behind lightning:.
    await page.getByLabel("Choose image").setInputFiles(await qrPicture(page, `lightning:${invoice.toUpperCase()}`));

    const review = page.getByTestId("wallet-pay-review");
    await expect(review).toContainText("Pay 13 test sats", { timeout: 30_000 });
    await expect(page.getByTestId("wallet-pay-description")).toHaveText("Scanned coffee");
    await page.getByTestId("wallet-pay-confirm").click();
    await expect(page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
    await expect(page.getByTestId("wallet-balance")).toContainText("9,98");
    await page.getByTestId("wallet-send-done").click();
    await expect(page.getByTestId("wallet-send-camera")).toBeVisible();
    await expect(page.getByTestId("wallet-pay-input")).toHaveValue("");
  });

  test("a Lightning address's QR asks for the amount, with the balance and Max, then pays", { tag: ["@feature:wallet.cashu.send-scan", "@feature:wallet.lnurl.address"] }, async ({ peer }) => {
    const server = new LocalLnurlServer(endpoints.lnurlPort);
    server.names.set("shop", { description: "Coffee at the shop", minSat: 5, maxSat: 50 });
    await server.start();
    try {
      const alice = await peer("alice");
      await useTestnet(alice);
      await getTestCoins(alice);
      const page = alice.page;

      await page.getByTestId("wallet-send").click();
      await page.getByLabel("Choose image").setInputFiles(await qrPicture(page, `lightning:${server.address("shop").toUpperCase()}`));
      const pay = page.getByTestId("wallet-lnurl");
      await expect(pay).toContainText(server.host);
      expect(server.requests, "nothing is fetched before the person asks").toHaveLength(0);
      await pay.getByTestId("lnurl-lookup").click();
      await expect(pay.getByTestId("lnurl-balance")).toContainText("Balance:");
      // Max: all the card holds, up to what the address takes.
      await pay.getByTestId("lnurl-max").click();
      await expect(pay.getByTestId("lnurl-amount")).toHaveValue("50");
      await pay.getByTestId("lnurl-amount").fill("8");
      await pay.getByTestId("lnurl-invoice").click();
      await expect(pay.getByTestId("lnurl-review")).toContainText("Pay 8 test sats to shop@");
      if (!process.env.E2E_MINT_URL) return;
      await pay.getByTestId("lnurl-pay").click();
      await expect(pay.getByTestId("lnurl-paid")).toContainText(`Paid 8 test sats to ${server.address("shop")}`);
      await expect.poll(() => server.paid("shop"), { timeout: 30_000 }).toBe(true);
    } finally { server.close(); }
  });

  test("on a phone, Scan, Paste and Choose image read whole in every language", { tag: ["@feature:wallet.cashu.send-scan", "@feature:app.i18n"] }, async ({ peer }) => {
    const alice = await peer("alice");
    await useTestnet(alice);
    const page = alice.page;
    await page.setViewportSize({ width: 375, height: 740 });
    const cut: Record<string, string[]> = {};
    for (const language of ["en", "pt", "es", "fr", "it", "ja", "zh", "ar"]) {
      await page.evaluate((language) => {
        const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
        localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
      }, language);
      await page.reload();
      await openWallet(alice, "cashu-testnet");
      await page.getByTestId("wallet-send").click();
      await expect(page.getByTestId("wallet-send-camera")).toBeVisible();
      // Each word of each label: on one line (a Japanese label, with no spaces, is one word), inside its button's padding.
      const words = await page.getByTestId("wallet-send-scan").evaluate((root) => [...root.querySelectorAll("button, label")].flatMap((button) => {
        const text = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
        if (!text) return [];
        const box = button.getBoundingClientRect(), style = getComputedStyle(button);
        const left = box.left + parseFloat(style.paddingLeft) - 1, right = box.right - parseFloat(style.paddingRight) + 1;
        return [...text.textContent!.matchAll(/\S+/g)].flatMap((word) => {
          const range = document.createRange();
          range.setStart(text, word.index!); range.setEnd(text, word.index! + word[0].length);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0);
          const lines = new Set(rects.map((r) => Math.round(r.top))).size;
          return lines > 1 ? [`"${word[0]}" broken over ${lines} lines`] : rects.some((r) => r.left < left || r.right > right) ? [`"${word[0]}" past its button's padding`] : [];
        });
      }));
      if (words.length) cut[language] = words;
    }
    expect(cut).toEqual({});
  });
});
