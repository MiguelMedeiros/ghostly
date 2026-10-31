import { describe, expect, it } from "vitest";
import { HOLD_MINUTES } from "../src/commands/shared";
import { HOLD_MAX_MINUTES } from "../src/holds";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/**
 * Number flags out of the API's range, on the commands with a flow of their own (send's text, listen, identity add): a usage error
 * that names the flag, before the profile opens. This home has no profile: anything past the check fails as no profile.
 */
describe("number flags out of range", () => {
  it("a send's --timeout, listen's --since and identity add's --days are usage errors before the profile opens", async () => {
    const dir = home("flag-ranges");
    const cases: [string[], string][] = [
      [["send", "bob", "hi", "--wait", "sent", "--timeout", "0"], "--timeout takes a number of seconds from 1 to 3600, not 0"],
      [["send", "bob", "hi", "--timeout", "3601"], "--timeout takes a number of seconds from 1 to 3600, not 3601"],
      [["edit", "bob", "me_w", "new", "--timeout", "-1"], "--timeout takes a number of seconds from 1 to 3600, not -1"],
      [["group", "send", "Crew", "hi", "--wait", "sent", "--timeout", "0"], "--timeout takes a number of seconds from 1 to 3600, not 0"],
      [["group", "edit", "Crew", "mekey:1:0", "new", "--timeout", "0"], "--timeout takes a number of seconds from 1 to 3600, not 0"],
      // It printed a made-up gap first, then the whole journal (with --webhook: "holding event -1 (events.gap)").
      [["listen", "--since", "-1"], "--since takes a seq from 0 up, not -1"],
      [["listen", "--since", "0.5", "--webhook", "http://127.0.0.1:5660/hook"], "--since takes a seq from 0 up, not 0.5"],
      // It answered "start ghostly daemon --detach first" here, and past that the API's or Node's words.
      [["service", "open", "bob", "web", "--port", "65536"], "--port takes a whole number from 0 to 65535, not 65536"],
      [["service", "open", "bob", "web", "--port", "-1"], "--port takes a whole number from 0 to 65535, not -1"],
      [["service", "open", "bob", "web", "--port", "1.5"], "--port takes a whole number from 0 to 65535, not 1.5"],
      // The API's words after the profile opened ("days must be a number from 1 to 365", exit 1), and for 1.5 the engine's.
      [["identity", "add", "ssh", "SHA256:x", "--days", "0"], "--days takes a whole number from 1 to 365, not 0"],
      [["identity", "add", "ssh", "SHA256:x", "--days", "99999"], "--days takes a whole number from 1 to 365, not 99999"],
      [["identity", "add", "ssh", "SHA256:x", "--days", "1.5"], "--days takes a whole number from 1 to 365, not 1.5"],
      [["identity", "add", "oidc", "--days", "15"], "--days takes a whole number from 1 to 14, not 15"],
      [["identity", "add", "nostr", "--timeout", "4"], "--timeout takes a number of seconds from 5 to 3600, not 4"],
      [["identity", "add", "nostr", "--timeout", "3601"], "--timeout takes a number of seconds from 5 to 3600, not 3601"],
    ];
    const seen = [];
    for (const [args] of cases) {
      const result = await ghostly(["--home", dir, ...args], { input: "" });
      seen.push({ args, code: result.code, json: result.json });
    }
    expect(seen).toMatchObject(cases.map(([args, message]) => ({ args, code: 2, json: { error: { code: "usage", message } } })));
  });

  it("--hold's range is the API's", () => {
    expect(HOLD_MINUTES).toBe(HOLD_MAX_MINUTES);
  });
});
