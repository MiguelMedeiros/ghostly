import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineState, GroupView } from "@ghostly/browser/shared/types";
import { findOwnNamedChat } from "./apiKit";
import { CliError } from "./errors";

/**
 * Auto-join (`group auto on --from <chat>`): the daemon accepts a group invitation by itself when it came over one of
 * the chats named, as `group accept` would. Kept in the profile's `groups.json` (0600). Each chat is kept with its
 * contact's key as it was when named: an invitation over a chat whose contact's key is no longer that one (another
 * contact behind the same chat id) is not accepted, and the chat leaves the list. There is no "from anyone": `on` needs
 * a chat.
 */
export interface AutoJoin { on: boolean; from: string[] }

/** A chat auto-join accepts invitations over, and its contact's key when it was named. */
interface Grant { chat: string; contact: string }

/** What auto-join needs of the engine: its state, and `group accept`. */
export interface GroupAutoEngine {
  getState(): EngineState;
  acceptGroupInvitation(params: { groupId: string }): Promise<void>;
}

export interface GroupAutoHost {
  engine: GroupAutoEngine;
  profileDir: string;
  /** Only a daemon accepts by itself; a one-shot only reads and changes the setting. */
  joins: boolean;
  /** The daemon's log (stderr by default). */
  log?: (line: string) => void;
}

const FILE = "groups.json";

export class GroupAutoJoin {
  private grants: Grant[];
  private readonly path: string;
  /** Invitations being accepted now. */
  private readonly accepting = new Set<string>();
  /** Per invitation: the last reason its accept failed, said once (it is tried again on the next change). */
  private readonly failed = new Map<string, string>();

  constructor(private readonly host: GroupAutoHost) {
    this.path = join(host.profileDir, FILE);
    this.grants = readGrants(this.path);
  }

  get(): AutoJoin { return { on: this.grants.length > 0, from: this.grants.map((g) => g.chat) }; }

  set(next: { on: boolean; from?: string[] }): AutoJoin {
    if (!next.on) {
      this.grants = [];
    } else {
      if (!next.from?.length) throw new CliError("bad_request", "Auto-join needs the chats whose invitations it accepts: group auto on --from <chat>");
      // Never a chat found only by a name its contact chose (`findOwnNamedChat`), as `call auto on --from`.
      const links = this.host.engine.getState().links;
      const grants = next.from.map((ref) => findOwnNamedChat(links, ref)).map((link) => ({ chat: link.id, contact: link.peerPubKeyZ32 }));
      this.grants = grants.filter((g, i) => grants.findIndex((x) => x.chat === g.chat) === i);
    }
    this.save();
    if (this.host.joins) this.check(this.host.engine.getState());
    return this.get();
  }

  /** A chat removed from this device leaves the list; the last one gone turns auto-join off. */
  forgetChat(chat: string): void {
    if (!this.grants.some((g) => g.chat === chat)) return;
    this.grants = this.grants.filter((g) => g.chat !== chat);
    this.save();
  }

  /**
   * Accepts the invitations that wait over a granted chat: on start (those that came while the daemon was down) and on
   * every change of the engine's state. One whose accept fails (the contact is not connected yet) is tried again on a
   * later change.
   */
  check(state: EngineState): void {
    if (!this.host.joins || !this.grants.length) return;
    const links = new Map(state.links.map((link) => [link.id, link]));
    const changed = this.grants.filter((g) => { const link = links.get(g.chat); return link && link.peerPubKeyZ32 !== g.contact; });
    if (changed.length) {
      for (const g of changed) this.log(`group auto: chat ${g.chat}'s contact key changed: its invitations are no longer accepted by themselves`);
      this.grants = this.grants.filter((g) => !changed.includes(g));
      this.save();
    }
    for (const group of state.groups) {
      const invitation = waiting(group);
      if (!invitation || this.accepting.has(group.id)) continue;
      const grant = this.grants.find((g) => g.chat === invitation.linkId);
      if (!grant || links.get(grant.chat)?.peerPubKeyZ32 !== grant.contact) continue;
      void this.accept(group.id, grant.chat);
    }
  }

  private async accept(groupId: string, chat: string): Promise<void> {
    this.accepting.add(groupId);
    try {
      await this.host.engine.acceptGroupInvitation({ groupId });
      this.failed.delete(groupId);
      this.log(`group auto: accepted the invitation to group ${groupId} from chat ${chat}`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (this.failed.get(groupId) !== why) this.log(`group auto: the invitation to group ${groupId} from chat ${chat} waits: ${why}`);
      this.failed.set(groupId, why);
    } finally {
      this.accepting.delete(groupId);
    }
  }

  private log(line: string): void { (this.host.log ?? ((text) => process.stderr.write(`ghostly: ${text}\n`)))(line); }

  private save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ autoJoin: { from: this.grants } }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/** An invitation over a contact chat that waits for this side's answer: not accepted yet, not taken back, not a link's. */
function waiting(group: GroupView): NonNullable<GroupView["invitation"]> | null {
  const invitation = group.invitation;
  if (group.status !== undefined || !invitation || invitation.accepted || invitation.takenBack || invitation.viaLink) return null;
  return invitation;
}

function readGrants(path: string): Grant[] {
  if (!existsSync(path)) return [];
  try {
    const saved = (JSON.parse(readFileSync(path, "utf8")) as { autoJoin?: { from?: unknown } }).autoJoin?.from;
    if (!Array.isArray(saved)) return [];
    return saved.filter((g): g is Grant => !!g && typeof g === "object" && typeof (g as Grant).chat === "string" && typeof (g as Grant).contact === "string");
  } catch {
    return [];
  }
}
