import { test, expect, choose, desktopWindows } from "../support/desktop";

/*
 * The message field in a right-to-left language, in the real WebView. In WebKitGTK an empty field laid out wide kept a
 * sideways overflow of a few pixels once the window narrowed to the phone layout with the chat open: a horizontal
 * scrollbar across the field, and a vertical one for the height that bar took. Left to right it never happened, nor in
 * a chat opened in a window already narrow. A message wraps, so the field never scrolls sideways.
 */

/** The field's scrollbars: how much of its box they take, across and down. */
const BARS = `
  const field = document.querySelector("textarea.composer-textarea");
  return field ? [field.offsetWidth - field.clientWidth, field.offsetHeight - field.clientHeight] : null;`;

test("in Arabic the message field shows no scrollbar after the window narrows with the chat open", { tag: ["@feature:app.i18n", "@feature:app.responsive"] }, async ({ app }) => {
  const windows = desktopWindows(app);
  await expect.poll(() => app.text('[title="New chat"]')).not.toBeNull();
  expect(await windows.resize(1280, 800), "the window takes the size asked for").toBe(1280);

  // A chat waiting for its contact has the field already.
  await app.click('[title="New chat"]');
  await expect.poll(() => app.execute(BARS), { message: "the chat shows its message field" }).toEqual([0, 0]);
  const chat = await app.execute<string>("return location.hash");

  await app.execute(`location.hash = "#/settings/appearance"`);
  await choose(app, "settings-language", "ar");
  await expect.poll(() => app.attribute("html", "dir")).toBe("rtl");
  await app.execute("location.hash = arguments[0]", chat);
  await expect.poll(() => app.execute(BARS), { message: "the field, wide" }).toEqual([0, 0]);

  expect(await windows.resize(400, 800), "the window takes the phone's width").toBe(400);
  // The layout settles a moment after the window does (a first reading may still show a bar that is on its way out):
  // wait for it, then read for a while, as a person looks at it. The bars this is about stayed for good.
  await expect.poll(() => app.execute(BARS), { message: "the field, once the narrow layout settled" }).toEqual([0, 0]);
  const seen = new Set<string>();
  for (const end = Date.now() + 2_000; Date.now() < end; await new Promise((done) => setTimeout(done, 200))) seen.add(JSON.stringify(await app.execute(BARS)));
  expect([...seen], "the field's scrollbars after the window narrowed").toEqual(["[0,0]"]);
});
