import { BUTTONS_CAPABILITY, STATUS_CARD_LIMITS, checkStatusCard, randomBytes, toBase64Url, type ButtonsCard } from "@ghostly/core";
import type { LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import type { Parsed } from "./args";
import { bool, chatOrGroup, node, num, oneOf, str, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";
import { waitForEdit, waitForGroupFrame } from "./waits";

/*
 * Message buttons (WISP 4xx · Message Buttons), the bot's side: a message whose text is the question, with up to six
 * buttons under it (`send --button yes:Yes`). A press comes back as a reply whose text is the button's label; the
 * engine marks it (`press`) and `listen` says `button.pressed`. `button update` then shows the answer (`chosen`) and
 * closes the buttons, by editing the message with the same buttons.
 */

/**
 * `--button id:Label` (again for each, 1 to 6), `--style id=primary|neutral|danger`, `--once` and `--id`, as the
 * method's parameters: `buttons` and `buttonsId`. Nothing when no `--button` is given. The label may hold colons: the
 * id ends at the first one. Bounds (ids, labels, how many) are the card's, checked when it is sent.
 */
export function buttonsOf(options: Parsed["options"]): { buttons: Record<string, unknown>[]; buttonsId?: string } | undefined {
  const given = Array.isArray(options.button) ? options.button as string[] : [];
  if (!given.length) {
    for (const flag of ["style", "once", "id"] as const)
      if (options[flag] !== undefined) throw new CliError("usage", `--${flag} goes with --button id:Label`);
    return undefined;
  }
  const buttons: Record<string, unknown>[] = given.map((value) => {
    const colon = value.indexOf(":");
    if (colon < 1 || colon === value.length - 1) throw new CliError("usage", `--button takes id:Label, like yes:Yes, not ${JSON.stringify(value)}`);
    return { id: value.slice(0, colon), label: value.slice(colon + 1).trim() };
  });
  for (const value of Array.isArray(options.style) ? options.style as string[] : []) {
    const eq = value.indexOf("=");
    const button = eq > 0 ? buttons.find((b) => b.id === value.slice(0, eq)) : undefined;
    if (!button) throw new CliError("usage", `--style takes id=primary|neutral|danger for one of the buttons, not ${JSON.stringify(value)}`);
    button.style = value.slice(eq + 1);
  }
  if (options.once === true) for (const button of buttons) button.once = true;
  return { buttons, ...(options.id !== undefined && { buttonsId: String(options.id) }) };
}

/** A buttons card checked by the sender's rule, or a `bad_request` that says what is wrong. */
function checked(card: Record<string, unknown>): ButtonsCard {
  const result = checkStatusCard(card);
  if ("error" in result) throw new CliError("bad_request", `Buttons: ${result.error}`, { card });
  return result.card as ButtonsCard;
}

/**
 * The card a send's `buttons` (and `buttonsId`) make, or undefined when it names none. `buttons` is a list of
 * `{id, label, style?, once?}`; the id of the question is made up (`ask-…`) unless given.
 */
export function buttonsCard(params: Params): ButtonsCard | undefined {
  const buttons = params.buttons;
  if (buttons === undefined || buttons === null) {
    if (params.buttonsId !== undefined) throw new CliError("bad_request", "buttonsId goes with buttons");
    return undefined;
  }
  if (!Array.isArray(buttons)) throw new CliError("bad_request", "buttons must be a list of {id, label, style?, once?}");
  const id = str(params, "buttonsId") ?? `ask-${toBase64Url(randomBytes(6))}`;
  return checked({ kind: "buttons", id, buttons });
}

/** Whether a 1:1 contact's app shows and presses buttons: null until its app said what it offers. */
export function pressable(link: LinkView): boolean | null {
  const peer = link.sessionOffers?.peer;
  return peer ? peer.includes(BUTTONS_CAPABILITY) : null;
}

/** The message of mine with buttons that `button update` names, by its id here (or the id both sides know). */
function buttonsMessage(messages: readonly StoredMessage[], ref: string, group: boolean): StoredMessage & { card: ButtonsCard } {
  const message = messages.find((m) => m.sender === "me" && m.id === ref) ?? messages.find((m) => m.sender === "me" && m.wireId === ref);
  if (!message) throw new CliError("not_found", `No message ${JSON.stringify(ref)} of yours in this ${group ? "group" : "chat"}: the messageId send gave`);
  if (message.card?.kind !== "buttons") throw new CliError("bad_request", "That message has no buttons: send one with send --button id:Label");
  return message as StoredMessage & { card: ButtonsCard };
}

/**
 * `button update`: the answer shown on a question's buttons (`chosen`), the buttons closed (`close`), or a new text
 * (`text`), by editing the message with the same buttons. What is not given stays as it was.
 */
async function updateButtons(ctx: Parameters<Method>[0], params: Params): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, str(params, "chat", true));
  const ref = str(params, "message", true);
  const chosen = str(params, "chosen");
  const close = bool(params, "close");
  const newText = str(params, "text");
  if (chosen === undefined && !close && newText === undefined) throw new CliError("bad_request", "Nothing to update: give chosen, close or text");
  const messages = target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId);
  const message = buttonsMessage(messages, ref, target.group);
  if ((message.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits)
    throw new CliError("refused", `This message took ${STATUS_CARD_LIMITS.edits} updates, the most one takes: ask again with a new send`, { messageId: message.id, edits: message.edit!.seq });
  const before = message.card;
  const card = checked({ ...before, ...(chosen !== undefined && { chosen }), ...((close || before.closed) && { closed: true }) });
  const text = newText ?? message.text;
  const wait = oneOf(params, "wait", target.group ? ["none", "sent"] as const : ["none", "confirmed"] as const, "none");
  const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
  const result = await node(ctx).editMessage({ linkId: target.linkId, messageId: message.id, text, card });
  if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
  let edited = (target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId)).find((m) => m.id === message.id);
  if (wait === "confirmed" && edited?.edit?.pending) edited = await waitForEdit(ctx, target.linkId, message.id, ms);
  const edges = wait === "sent" && edited?.edit ? await waitForGroupFrame(ctx, target.id, message.id, edited.edit.seq, ms) : undefined;
  return {
    [target.group ? "group" : "chat"]: target.id, buttons: card.id, messageId: message.id, card, edits: edited?.edit?.seq ?? 0,
    ...(target.group ? { ...(edges !== undefined && { edges }) } : { confirmed: !!edited && !edited.edit?.pending }),
  };
}

export const BUTTON_METHODS: Record<string, Method> = {
  /** WISP 4xx · Message Buttons: the answer chosen on a question of mine, its buttons closed, or its text changed. */
  "button.update": updateButtons,
};
