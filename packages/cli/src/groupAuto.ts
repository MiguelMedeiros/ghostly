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

/** What auto-join needs of the engine: its state, `group accept`, and picking another group kept under an id. */
export interface GroupAutoEngine {
  getState(): EngineState;
  acceptGroupInvitation(params: { groupId: string }): Promise<void>;
  switchGroup(params: { groupId: string; to: string }): Promise<void>;
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
  /** Invitations over a granted chat kept beside a group that is not just an invitation, said once each. */
  private readonly heldSaid = new Set<string>();

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
      // Never a chat found only by a name its contact chose (`findOwnNamedChat`), as `call auto on --from`; a group's
      // name or id is refused as one ("is a group, not a chat", with its id), as there.
      const { links, groups } = this.host.engine.getState();
      const grants = next.from.map((ref) => findOwnNamedChat(links, ref, groups)).map((link) => ({ chat: link.id, contact: link.peerPubKeyZ32 }));
      this.grants = grants.filter((g, i) => grants.findIndex((x) => x.chat === g.chat) === i);
    }
    this.save();
    if (this.host.joins) this.check(this.host.engine.getState());
    return this.get();
  }

  /**
   * Whether an invitation over this chat is one this profile accepts by itself: the chat is on the list and its contact's
   * key is still the one named. The engine asks it when 32 invitations wait (`NodeOptions.autoJoins`): such an invitation
   * then takes the place of the oldest waiting from the chat that holds the most, so the invitations of contacts nobody
   * answers here cannot keep the owner's out.
   */
  autoJoins(chat: string): boolean {
    const grant = this.grants.find((g) => g.chat === chat);
    return !!grant && this.host.engine.getState().links.find((link) => link.id === chat)?.peerPubKeyZ32 === grant.contact;
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
   * later change. Another contact who knows the group's id may have invited first: the engine then keeps the granted
   * one beside it (`others`), and it is the one taken (`switchGroup`, which tells the other contact no), as long as the
   * group held is only an invitation not answered yet. One beside a group joined or accepted waits for the person.
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
    const granted = (chat: string) => this.grants.some((g) => g.chat === chat && links.get(chat)?.peerPubKeyZ32 === g.contact);
    for (const group of state.groups) {
      if (this.accepting.has(group.id)) continue;
      const invitation = waiting(group);
      if (invitation && granted(invitation.linkId)) { void this.accept(group.id, invitation.linkId); continue; }
      const other = group.others?.find((o) => "linkId" in o && granted(o.linkId));
      if (!other || !("linkId" in other)) continue;
      const held = group.invitation;
      if (group.status === undefined && held && !held.accepted && !held.viaLink) { void this.accept(group.id, other.linkId, true); continue; }
      const said = `${group.id}:${other.linkId}`;
      if (this.heldSaid.has(said)) continue;
      this.heldSaid.add(said);
      this.log(`group auto: an invitation to group ${group.id} from chat ${other.linkId} is kept beside another group under the same id: it waits for you (ghostly group show ${group.id})`);
    }
  }

  /** `switched`: the invitation is the one kept beside another contact's under its id, which it takes the place of first. */
  private async accept(groupId: string, chat: string, switched = false): Promise<void> {
    this.accepting.add(groupId);
    try {
      if (switched) await this.host.engine.switchGroup({ groupId, to: chat });
      await this.host.engine.acceptGroupInvitation({ groupId });
      this.failed.delete(groupId);
      this.log(`group auto: accepted the invitation to group ${groupId} from chat ${chat}${switched ? " (another contact's under the same id declined)" : ""}`);
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
