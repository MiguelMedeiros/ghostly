import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import type { Page } from "@playwright/test";

/** A PNG of `text`'s QR, as a screenshot of one would be: drawn by the app's own QR component, on a blank page. */
export async function qrPicture(page: Page, text: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: text, size: 360, marginSize: 4 }));
  const blank = await page.context().newPage();
  try {
    await blank.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    return { name: "qr.png", mimeType: "image/png", buffer: await blank.locator("svg").screenshot() };
  } finally { await blank.close(); }
}
