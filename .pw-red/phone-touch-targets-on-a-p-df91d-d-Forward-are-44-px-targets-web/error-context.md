# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/phone-touch-targets.spec.ts >> on a phone a message's Delete question, reply and edit bars, pin, details, select bar and Forward are 44 px targets
- Location: e2e/web/phone-touch-targets.spec.ts:209:1

# Error details

```
Error: a message's controls under 44 × 44 px on a phone

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "long key and code block: button \"rich-blob-copy\" 47×37 (left rich-blob-toggle, right div.relative.max-w-full.min-w-[80px], top message-body, bottom message-time)",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e4]:
    - main [ref=e5]:
      - generic [ref=e7]:
        - paragraph [ref=e8]
        - generic [ref=e9]:
          - generic [ref=e10]:
            - generic [ref=e11]:
              - button "Back" [ref=e12] [cursor=pointer]
              - generic [ref=e28]:
                - generic [ref=e29]:
                  - heading [level=1] [ref=e30]:
                    - button "Contact" [ref=e31] [cursor=pointer]
                  - generic [ref=e33]: Online
                - paragraph [ref=e36]:
                  - status
                  - text: xcd1h4...usjkqy
            - generic [ref=e37]:
              - generic [ref=e38]:
                - group [ref=e39]:
                  - 'generic "Connection options: Connected · WebRTC" [ref=e40] [cursor=pointer]'
                - generic [ref=e44]: Connected · WebRTC
              - button "Audio call" [ref=e45] [cursor=pointer]
              - status
              - generic [ref=e48]:
                - button "Options" [ref=e49] [cursor=pointer]
                - status [ref=e54]
          - generic [ref=e56]:
            - button "Pinned message theirs on a small screen" [ref=e57] [cursor=pointer]:
              - generic [ref=e62]:
                - generic [ref=e63]: Pinned message
                - generic [ref=e64]: theirs on a small screen
            - button "More info" [ref=e65] [cursor=pointer]
            - button "Unpin" [ref=e68] [cursor=pointer]
          - generic [ref=e73]:
            - paragraph [ref=e74]:
              - time [ref=e75]: Chat created Nov 25, 2026, 3:18 AM
            - generic [ref=e76]:
              - generic:
                - time: Today
              - generic [ref=e77]:
                - generic [ref=e83]:
                  - text: hello from bob
                  - generic [ref=e84]: 03:18 AM
                - button "Message options" [ref=e88] [cursor=pointer]
              - generic [ref=e93]:
                - button "Message options" [ref=e95] [cursor=pointer]
                - generic [ref=e105]:
                  - text: hello from alice
                  - generic [ref=e107]:
                    - generic [ref=e108]: 03:18 AM
                    - img "Delivered" [ref=e110]
              - button "Connected over WebRTC 03:18 AM" [ref=e115] [cursor=pointer]:
                - generic [ref=e119]: Connected over WebRTC
                - time [ref=e120]: 03:18 AM
              - generic [ref=e121]:
                - generic "k9fkatjj5o6f4dwgj6y9pdjkq4u3s3t7xeujd1z8jrunx79c818o" [ref=e122]:
                  - generic [ref=e126]: You joined the chat
                  - generic [ref=e127]: 03:18 AM
                - button "Message options" [ref=e129] [cursor=pointer]
              - generic [ref=e134]:
                - generic "xcd1h4a9gyoyezjomhwcoyaxtpocdf1t46mzzs64wzboziusjkqy" [ref=e135]:
                  - generic [ref=e139]: xcd1h4...usjkqy joined the chat
                  - generic [ref=e140]: 03:18 AM
                - button "Message options" [ref=e142] [cursor=pointer]
              - generic [ref=e147]:
                - generic [ref=e153]:
                  - text: theirs on a small screen
                  - generic [ref=e154]: 03:18 AM
                - button "Message options" [ref=e158] [cursor=pointer]
              - generic [ref=e163]:
                - button "Message options" [ref=e165] [cursor=pointer]
                - generic [ref=e175]:
                  - text: mine on a small screen
                  - generic [ref=e177]:
                    - generic [ref=e178]: 03:18 AM
                    - img "Delivered" [ref=e180]
              - generic [ref=e184]:
                - generic [ref=e190]:
                  - generic [ref=e191]:
                    - text: key
                    - generic [ref=e193]:
                      - code [ref=e194]: Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy
                      - generic [ref=e195]:
                        - button "Show all" [ref=e196] [cursor=pointer]
                        - button "Copy" [ref=e197] [cursor=pointer]
                    - text: from the Mac
                  - generic [ref=e198]: 03:18 AM
                - button "Message options" [ref=e202] [cursor=pointer]
              - generic [ref=e207]:
                - generic [ref=e213]:
                  - generic [ref=e215]:
                    - generic [ref=e216]:
                      - generic [ref=e217]: js
                      - button "Copy code" [ref=e218] [cursor=pointer]: Copy
                    - code [ref=e220]: const a = 1;
                  - generic [ref=e221]: 03:18 AM
                - button "Message options" [ref=e225] [cursor=pointer]
          - generic [ref=e232]:
            - generic [ref=e233]:
              - button "Attach" [ref=e235] [cursor=pointer]
              - button "Emoji and GIFs" [ref=e238] [cursor=pointer]
              - textbox "Message…" [ref=e243]
            - button "Record a voice message" [ref=e245] [cursor=pointer]
      - status [ref=e248]
    - paragraph [ref=e249]
  - status
```

# Test source

```ts
  173 |     expect(box.x, `${label}: the ⋮ starts inside the screen`).toBeGreaterThanOrEqual(0);
  174 |     expect(box.x + box.width, `${label}: the ⋮ ends inside the screen`).toBeLessThanOrEqual(vw);
  175 |     const small = (await smallTargets(page)).filter((target) => target.name.includes("message-options"));
  176 |     expect(small.map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`), `${label}: a system line's ⋮ under 44 × 44 px`).toEqual([]);
  177 |   };
  178 | 
  179 |   test("keeps its ⋮ a 44 px target inside the screen, in Japanese and in Arabic", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n", "@feature:chat.paired.join-notice"] }, async ({ peer }, testInfo) => {
  180 |     test.setTimeout(3 * 60_000);
  181 |     const alice = await peer("alice", { mobile: true, viewport: { width: 375, height: 667 } });
  182 |     const bob = await peer("bob");
  183 |     await link(alice, bob);
  184 |     await connect(alice, bob);
  185 | 
  186 |     await speak(alice, "ja", "ltr");
  187 |     await checkJoined(alice, "あなたがチャットに参加しました", "ja");
  188 |     await alice.page.screenshot({ path: testInfo.outputPath("joined-ja-375.png") });
  189 | 
  190 |     // Arabic's line is shorter: it wraps on the narrowest phone, with the ⋮ at the left edge.
  191 |     await alice.page.setViewportSize({ width: 320, height: 568 });
  192 |     await speak(alice, "ar", "rtl");
  193 |     await checkJoined(alice, "انضممت إلى المحادثة", "ar");
  194 |     await alice.page.screenshot({ path: testInfo.outputPath("joined-ar-320.png") });
  195 | 
  196 |     await speak(alice, "en", "ltr");
  197 |     await alice.page.screenshot({ path: testInfo.outputPath("joined-en-320.png") });
  198 |   });
  199 | });
  200 | 
  201 | /**
  202 |  * What a message's ⋮ opens shows only once it is chosen, so the screens above never reach it: the Delete question's
  203 |  * Cancel and Delete were 40 px tall, the reply and edit bars' × 36 px wide, the pinned message 42 px tall, the details'
  204 |  * × 28 px and its Copy as JSON 26 px tall, the select bar's Cancel 34 px and its Forward 41 px tall, the Forward dialog's
  205 |  * Cancel and Send 41 px tall. The details' copy values stay 24 px tall rows in a dense list, so only its × and Copy as
  206 |  * JSON are measured there. In the bubble itself, a long key's Show all and Copy and a code block's Copy were 20 px tall
  207 |  * (Copy 26 px wide); a spoiler and a written time sit inside a sentence, as a link in text does, and are left out.
  208 |  */
  209 | test("on a phone a message's Delete question, reply and edit bars, pin, details, select bar and Forward are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.delete-message", "@feature:chat.replies", "@feature:chat.edit", "@feature:chat.pins", "@feature:chat.paired.message-details", "@feature:chat.forward"] }, async ({ peer }, testInfo) => {
  210 |   test.setTimeout(4 * 60_000);
  211 |   const alice = await peer("alice", { mobile: true, viewport: { width: 375, height: 667 } });
  212 |   const bob = await peer("bob");
  213 |   await link(alice, bob);
  214 |   await connect(alice, bob);
  215 |   await say(bob, "theirs on a small screen");
  216 |   await say(alice, "mine on a small screen");
  217 |   await expect(chat(alice).getByText("theirs on a small screen")).toBeVisible();
  218 |   const { page } = alice;
  219 |   const small: string[] = [];
  220 |   const measure = async (state: string, controls?: string) => {
  221 |     for (const target of await smallTargets(page, 44, controls)) small.push(`${state}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
  222 |     await page.screenshot({ path: testInfo.outputPath(`${state.replace(/\W+/g, "-")}.png`) });
  223 |   };
  224 |   const choose = async (text: string, item: string) => {
  225 |     await chat(alice).locator("[data-message-row]").filter({ hasText: text }).last().getByTestId("message-options").click();
  226 |     await page.getByTestId("message-menu").getByTestId(item).click();
  227 |   };
  228 | 
  229 |   await choose("theirs on a small screen", "message-delete");
  230 |   await expect(page.getByTestId("message-delete-confirm")).toBeVisible();
  231 |   await measure("Delete question", "[data-testid=message-delete-menu] button");
  232 |   await page.keyboard.press("Escape");
  233 | 
  234 |   await choose("theirs on a small screen", "message-reply");
  235 |   await expect(page.getByTestId("composer-reply")).toBeVisible();
  236 |   await measure("reply bar", "[data-testid=composer-reply-cancel]");
  237 |   await page.getByTestId("composer-reply-cancel").click();
  238 | 
  239 |   await choose("mine on a small screen", "message-edit");
  240 |   await expect(page.getByTestId("composer-edit")).toBeVisible();
  241 |   await measure("edit bar", "[data-testid=composer-edit-cancel]");
  242 |   await page.getByTestId("composer-edit-cancel").click();
  243 | 
  244 |   await choose("theirs on a small screen", "message-pin");
  245 |   await expect(page.getByTestId("pinned-bar")).toBeVisible();
  246 |   await measure("pinned bar", "[data-testid=pinned-bar] button");
  247 | 
  248 |   await choose("theirs on a small screen", "message-details");
  249 |   await expect(page.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes");
  250 |   await measure("details", "[data-testid=message-details-close], [data-testid=message-details-copy-all]");
  251 |   await page.getByTestId("message-details-close").click();
  252 |   await expect(page.getByTestId("message-details")).toHaveCount(0);
  253 | 
  254 |   await choose("theirs on a small screen", "message-select-start");
  255 |   await expect(page.getByTestId("select-forward")).toBeEnabled();
  256 |   await measure("select bar", "[data-testid=select-bar] button");
  257 | 
  258 |   await page.getByTestId("select-forward").click();
  259 |   await page.getByTestId("forward-target").first().click();
  260 |   await expect(page.getByTestId("forward-send")).toBeEnabled();
  261 |   await measure("Forward dialog", "[data-testid=forward-dialog] button");
  262 |   await page.keyboard.press("Escape");
  263 |   await page.keyboard.press("Escape");
  264 | 
  265 |   // In the message itself: a long key's Show all and Copy, a code block's Copy (20 px tall, Copy 26 px wide). The key has
  266 |   // a line under it: on a message's last line the time beside its end stays on top of Copy's lower edge (a message of
  267 |   // mine has its delivery mark there, a control of its own).
  268 |   await say(bob, `key ${"Zm9vYmFy".repeat(16)}\nfrom the Mac`);
  269 |   await say(bob, "```js\nconst a = 1;\n```");
  270 |   await expect(chat(alice).getByTestId("rich-codeblock")).toBeVisible();
  271 |   await measure("long key and code block", "[data-testid=rich-blob-toggle], [data-testid=rich-blob-copy], [data-testid=rich-codeblock-copy]");
  272 | 
> 273 |   expect(small, "a message's controls under 44 × 44 px on a phone").toEqual([]);
      |                                                                     ^ Error: a message's controls under 44 × 44 px on a phone
  274 | });
  275 | 
  276 | test.describe("the voice recorder on a phone", () => {
  277 |   /**
  278 |    * The hands-free recorder's bar shows only while it records, so the screens above never reach it: its bin, Pause /
  279 |    * Resume and the preview's Play were 36 × 36 px, the Discard question's Keep and Discard 34 px tall. Chromium's fake
  280 |    * microphone (the web project's launch flags) records; the mic is started from the keyboard, which always records
  281 |    * hands-free (a tap of a finger on it only shows how it works).
  282 |    */
  283 |   test("its bin, Pause, Resume, the preview's Play and the Discard question's Keep and Discard are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:files.voice.record"] }, async ({ peer }, testInfo) => {
  284 |     test.setTimeout(3 * 60_000);
  285 |     const [alice, bob] = await Promise.all([peer("voice-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("voice-phone-bob")]);
  286 |     await pair(alice, bob);
  287 |     const { page } = alice;
  288 |     const bar = page.getByTestId("voice-bar");
  289 |     const small = new Map<string, string>();
  290 |     const measure = async (screen: string) => {
  291 |       for (const target of await smallTargets(page)) if (!small.has(target.name)) small.set(target.name, `${screen}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
  292 |     };
  293 | 
  294 |     const mic = page.getByTestId("voice-record");
  295 |     await expect(mic).not.toHaveAttribute("aria-disabled");
  296 |     await mic.focus();
  297 |     await page.keyboard.press("Enter");
  298 |     await expect(bar).toHaveAttribute("data-mode", "locked");
  299 |     await expect(bar).toHaveAttribute("data-phase", "recording");
  300 |     await expect(page.getByTestId("voice-delete")).toBeVisible();
  301 |     // Past the 3 s after which Esc asks before it throws the recording away.
  302 |     await page.waitForTimeout(4_000);
  303 |     await measure("recording (bin, Pause)");
  304 |     await page.screenshot({ path: testInfo.outputPath("voice-recording.png") });
  305 | 
  306 |     await page.getByTestId("voice-pause").click();
  307 |     await expect(bar).toHaveAttribute("data-phase", "paused");
  308 |     await expect(page.getByTestId("voice-preview")).toBeVisible();
  309 |     await measure("paused (bin, preview Play, Resume)");
  310 |     await page.screenshot({ path: testInfo.outputPath("voice-paused.png") });
  311 | 
  312 |     await page.getByTestId("voice-pause").click();
  313 |     await expect(bar).toHaveAttribute("data-phase", "recording");
  314 |     await page.keyboard.press("Escape");
  315 |     await expect(page.getByTestId("voice-confirm")).toBeVisible();
  316 |     await measure("Discard? (Keep, Discard)");
  317 |     await page.screenshot({ path: testInfo.outputPath("voice-discard-question.png") });
  318 |     for (const id of ["voice-confirm-keep", "voice-confirm-discard"]) {
  319 |       const box = (await page.getByTestId(id).boundingBox())!;
  320 |       expect(box.height, `${id} drawn as before, inside the bar`).toBeLessThan(44);
  321 |     }
  322 |     await page.getByTestId("voice-confirm-discard").click();
  323 |     await expect(bar).toHaveCount(0);
  324 | 
  325 |     expect([...small.values()], "controls under 44 × 44 px on a phone").toEqual([]);
  326 |   });
  327 | });
  328 | 
  329 | test.describe("a voice message on a phone", () => {
  330 |   /** Ghostly's own Offline switch, on the Services page, then back to the chat (large-files.spec.ts). */
  331 |   const setOnline = async ({ page }: Peer, online: boolean) => {
  332 |     await page.getByTestId("account-services").click();
  333 |     const toggle = page.getByTestId("online-toggle");
  334 |     if ((await toggle.getAttribute("aria-checked")) !== String(online)) await toggle.click();
  335 |     await expect(toggle).toHaveAttribute("aria-checked", String(online));
  336 |     await page.goBack();
  337 |     await expect(page.getByPlaceholder("Message…")).toBeVisible();
  338 |   };
  339 | 
  340 |   /** Drops what a page sends its contacts over WebRTC, until it restarts (large-files.spec.ts holds them instead). */
  341 |   const dropSends = ({ page }: Peer) => page.evaluate(() => {
  342 |     RTCDataChannel.prototype.send = () => {};
  343 |   });
  344 | 
  345 |   /**
  346 |    * The speed pill shows only while a note plays or waits mid-way, and a sent note's round Resend only once it stopped
  347 |    * on its way, so the screens above reach neither: the pill took taps on 42 × 26 px, the Resend on 37 × 36. Bob's note
  348 |    * is played and paused. Alice's is offered while nothing she sends reaches Bob, Bob goes offline and her app restarts
  349 |    * with it unsent: stuck since the start, it offers Send again.
  350 |    */
  351 |   test("the speed pill and a sent note's Resend are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:files.voice.play", "@feature:files.large.resend"] }, async ({ peer }, testInfo) => {
  352 |     test.setTimeout(4 * 60_000);
  353 |     const [alice, bob] = await Promise.all([peer("voice-note-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("voice-note-phone-bob")]);
  354 |     await pair(alice, bob);
  355 |     const { page } = alice;
  356 |     const small = new Map<string, string>();
  357 |     const measure = async (screen: string) => {
  358 |       for (const target of await smallTargets(page)) if (!small.has(target.name)) small.set(target.name, `${screen}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
  359 |     };
  360 |     /** Hands-free from the keyboard (the recorder's test above), sent after `ms`. */
  361 |     const record = async (who: Peer, ms: number) => {
  362 |       const mic = who.page.getByTestId("voice-record");
  363 |       await expect(mic).not.toHaveAttribute("aria-disabled");
  364 |       await mic.focus();
  365 |       await who.page.keyboard.press("Enter");
  366 |       await expect(who.page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  367 |       await who.page.waitForTimeout(ms);
  368 |       await who.page.getByTestId("voice-send").click();
  369 |       await expect(who.page.getByTestId("voice-bar")).toHaveCount(0);
  370 |     };
  371 | 
  372 |     await record(bob, 4_000);
  373 |     const received = chat(alice).getByTestId("voice-bubble").last();
```