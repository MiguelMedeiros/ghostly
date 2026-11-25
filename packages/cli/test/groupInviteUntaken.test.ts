import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.group-admin

/**
 * `group invite` of a chat whose invite nobody took yet: there is no contact to invite, and none to come online. The
 * engine's "This contact is not connected right now. Invite them when they are online." sent a person to wait for a
 * contact that does not exist yet. Refused as `chat connect` refuses such a chat, with the command that waits for them.
 */
describe("group invite of a chat nobody joined yet", () => {
  it("says nobody joined it, and names chat wait", { timeout: 60_000 }, async () => {
    const dir = home("group-invite-untaken");
    ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"]));
    ok(await ghostly(["--home", dir, "group", "create", "Crew", "--mesh"]));
    const refused = error(await ghostly(["--home", dir, "group", "invite", "Crew", "bob"]), "unavailable", 1);
    expect(refused.message).toBe("Nobody joined chat bob yet: invite them once they take its invite and are online (ghostly chat wait bob)");
    expect(ok(await ghostly(["--home", dir, "group", "show", "Crew"])).members).toHaveLength(1);
  });
});
