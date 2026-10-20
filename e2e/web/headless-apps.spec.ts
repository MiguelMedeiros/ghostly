import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";
import { ChessPublisher, chessFrame, chessStatus, miniApp } from "../support/chessApp";
import { CHESS } from "../support/chessFixture";

/*
 * A bot on the headless Ghostly as the other side of a mini-app (WISP 1200 § A bot on the other side; WISP 1100 § Apps
 * as a bot), with a person on the web app. The bot serves the real Chess, runs none of it, and speaks its protocol
 * itself: it opens Chess in the chat, the person gets the app card and installs Chess from it, the two sides say hello,
 * and the bot's invitation shows in the person's Chess with Accept, which the bot hears.
 */
test.describe.configure({ timeout: 5 * 60_000 });

/** Chess's commitment to a salt (its docs/protocol.md): SHA-256("ghostly-chess/1 commit", 0x00, salt), in hex. */
const commitment = (salt: Buffer) => createHash("sha256").update("ghostly-chess/1 commit").update(Buffer.from([0])).update(salt).digest("hex");
type Frame = { p?: string; v?: number; k?: string; [field: string]: unknown };
const frameOf = (kind: string) => (e: Record<string, unknown>) => e.type === "app.message" && (e.data as Frame | null)?.k === kind;

test("a bot on the CLI opens Chess with a person: the card, the app installed from it, and the app's messages both ways", {
  tag: ["@feature:headless.apps", "@feature:headless.web-interop", "@feature:apps.chat.card", "@feature:apps.chat.wire"],
}, async ({ peer, relay }, info) => {
  const url = await relay.listen();
  const publisher = new ChessPublisher();
  const chess = publisher.publish({ sequence: 5 });
  const bot = new HeadlessBot();
  try {
    // The bot serves Chess from its signed bundle before its daemon starts, granting what the manifest asks.
    const bundle = join(bot.home, "chess.ghostlyapp");
    writeFileSync(bundle, chess.bytes);
    await expect(bot.run("app", "serve", bundle)).rejects.toThrow(/--grant chat --grant name/);
    expect(await bot.run("app", "serve", bundle, "--grant", "chat", "--grant", "name")).toMatchObject({ served: { ref: chess.ref, digest: chess.digest, version: CHESS.manifest.version, url: chess.url } });
    await bot.start(url, "Chess bot");
    expect(await bot.run("app", "served")).toMatchObject({ offered: true });

    const person = await peer("person");
    const asked = await publisher.serve(person.context);
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

    // 1. The bot opens Chess: the person gets its card, as from a person's app, and nothing was fetched to show it.
    expect(await bot.run("app", "open", invite.chat as string, "chess")).toMatchObject({ app: chess.ref, peer: null, live: true });
    const card = chat(person).getByTestId("app-card");
    await expect(card).toContainText(`Chess ${CHESS.manifest.version}`);
    await expect(card).toContainText("Chess bot opened it here");
    expect(asked).toEqual([]);

    // 2. The person installs Chess from the card and it opens in the chat: the bot hears it open, and its hello.
    await card.getByTestId("app-card-install").click();
    const screen = person.page.getByTestId("app-install");
    await expect(screen.getByTestId("app-sent-by")).toHaveText("Sent by Chess bot");
    await screen.getByTestId("app-install-confirm").click();
    await expect(miniApp(person.page)).toBeVisible();
    expect(asked).toContain(chess.url);
    expect(await bot.event((e) => e.type === "app.opened")).toMatchObject({ chat: invite.chat, app: chess.ref, version: CHESS.manifest.version });
    expect((await bot.event(frameOf("hello"))).data).toMatchObject({ p: "chess", v: 2, k: "hello", pv: 2 });

    // 3. The bot answers the hello and invites to a 10 minute game, in Chess's own protocol: the person's Chess shows
    // the invitation, and the bot's name over the board.
    const send = (frame: Frame) => bot.run("app", "send", invite.chat as string, "chess", JSON.stringify({ p: "chess", v: 2, ...frame }));
    expect(await send({ k: "hello", pv: 2, f: ["clock", "takeback", "rematch", "abort", "names"], n: "Chess bot", re: 1 })).toMatchObject({ sent: true });
    const salt = randomBytes(32);
    await send({ k: "seek", c: commitment(salt), a: [], tc: [600, 0] });
    const invitation = chessFrame(person.page).locator(".invitation");
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText("10");

    // 4. The person accepts: the bot hears the person's own seek, with the same terms, and its reveal for the bot's commitment.
    await invitation.locator(".accept-invite").click();
    expect((await bot.event(frameOf("seek"))).data).toMatchObject({ k: "seek", tc: [600, 0] });
    expect((await bot.event(frameOf("reveal"))).data).toMatchObject({ k: "reveal", c: commitment(salt) });

    // 5. The bot closes Chess: the person's Chess says the contact's is closed, and the bot can send no more.
    await bot.run("app", "close", invite.chat as string, "chess");
    await expect(chessStatus(person.page)).toHaveText(/contact/i);
    await expect(send({ k: "hello", pv: 2, f: [], re: 1 })).rejects.toThrow(/not-open/);
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
  }
});
