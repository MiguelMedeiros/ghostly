import { test, expect, choose, desktopWindows } from "../support/desktop";

/*
 * The phone tab bar's names, drawn whole in the real WebView. A name hides its overflow (it ends in an ellipsis when it
 * is too long), and its line box was the font's size: Latin letters fit in it, but in WebKitGTK Japanese and Chinese
 * glyphs (a fallback font's) rose 2 to 3 px above it and lost their tops (チャット read as ナャット), and Arabic's
 * الإعدادات lost the bottom of its hamza.
 */

/**
 * How far each name's ink goes past the box that clips it, above and below, in px. The WebView's own font metrics
 * (a canvas with the name's font) and CSS's line model: the line box is `line-height` tall, inside the padding, and
 * the font's ascent and descent sit in its middle.
 */
const INK = `
  const pen = document.createElement("canvas").getContext("2d");
  return [...document.querySelectorAll('[data-testid="mobile-tabs"] button > span:last-child')].map((name) => {
    const style = getComputedStyle(name);
    pen.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    const m = pen.measureText(name.textContent);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
    const baseline = parseFloat(style.paddingTop) + (line - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 + m.fontBoundingBoxAscent;
    return [name.textContent, Math.max(0, m.actualBoundingBoxAscent - baseline), Math.max(0, baseline + m.actualBoundingBoxDescent - name.clientHeight)];
  });`;

for (const language of ["ja", "zh", "ar"]) {
  test(`in ${language} the tab bar's names are drawn whole`, { tag: ["@feature:app.i18n", "@feature:app.responsive"] }, async ({ app }) => {
    const windows = desktopWindows(app);
    await expect.poll(() => app.text('[title="New chat"]')).not.toBeNull();
    expect(await windows.resize(1280, 800), "the window takes the size asked for").toBe(1280);
    await app.execute(`location.hash = "#/settings/appearance"`);
    await choose(app, "settings-language", language);
    expect(await windows.resize(400, 800), "the window takes the phone's width").toBe(400);
    await expect.poll(() => app.execute<unknown[]>(INK).then((names) => names.length), { message: "the tab bar shows" }).toBeGreaterThan(3);
    const names = await app.execute<[string, number, number][]>(INK);
    expect(names.filter(([, above, below]) => above > 0 || below > 0), "names cut above or below").toEqual([]);
  });
}
