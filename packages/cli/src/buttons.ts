import { BUTTONS_CAPABILITY, STATUS_CARD_LIMITS, buttonLabelClash, checkStatusCard, randomBytes, toBase64Url, type ButtonsCard } from "@ghostly/core";
import type { LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import type { Parsed } from "./args";
import { bool, chatOrGroup, node, num, oneOf, str, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";
import { findSecret } from "../../../apps/ui/src/lib/parse/secrets";
import { waitForEdit, waitForGroupFrame, waitForMessage } from "./waits";

/*
 * Message buttons (WISP 406 · Message Buttons), the bot's side: a message whose text is the question, with up to six
 * buttons under it (`send --button yes:Yes`). A press comes back as a reply whose text is the button's label; the
 * engine marks it (`press`) and `listen` says `button.pressed`. `button update` then shows the answer (`chosen`) and
 * closes the buttons, by editing the message with the same buttons.
 */

/**
 * `--button id:Label` (again for each, 1 to 6), `--style id=primary|neutral|danger`, `--once` and `--id`, as the
 * method's parameters: `buttons` and `buttonsId`. Nothing when no `--button` is given. The label may hold colons: the
 * id ends at the first one. Two labels that read the same (ignoring case and spaces at the ends), or a label that is
 * another button's id, are a usage error here; other bounds (ids, labels, how many) are the card's, checked when it is sent.
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
  // Two buttons a typed answer could not tell apart: the same label, or a label that is another's id (ignoring case).
  const clash = buttonLabelClash(buttons);
  if (clash) {
    const [at, other] = [JSON.stringify(given[clash.at]), JSON.stringify(given[clash.with])];
    throw new CliError("usage", clash.kind === "label"
      ? `--button ${at} repeats the label of --button ${other} (ignoring case and spaces): a typed answer could not tell them apart`
      : `--button ${at} has a label that is the id of --button ${other}: a typed answer could not tell them apart`);
  }
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
  // A new text is a message like any other: the same guard as `send` and `edit`.
  if (newText !== undefined && !bool(params, "force")) {
    const secret = findSecret(newText);
    if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; update with --force if you mean to`, { kind: secret.kind });
  }
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

/**
 * `button press`: the other side of a question, as the app's tap: a press on a button of someone else's message, by
 * its id here (or the id both sides know). The engine sends a reply whose text is the button's label, and refuses what
 * an app would: a button the message does not have, closed buttons, a second answer past `once`, a second press
 * within a second. A one-shot in a chat waits until the press went out, as `send` does.
 */
async function pressButton(ctx: Parameters<Method>[0], params: Params): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, str(params, "chat", true));
  const ref = str(params, "message", true);
  const buttonId = str(params, "button", true);
  const where = target.group ? "group" : "chat";
  const messages = target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId);
  const theirs = messages.filter((m) => m.sender !== "me");
  const message = theirs.find((m) => m.id === ref) ?? theirs.find((m) => m.wireId === ref);
  if (!message) throw new CliError("not_found", `No message ${JSON.stringify(ref)} from someone else in this ${where}: the id its event or history gave`);
  if (message.card?.kind !== "buttons") throw new CliError("bad_request", "That message has no buttons");
  const button = message.card.buttons.find((b) => b.id === buttonId);
  if (!button) throw new CliError("not_found", `That message has no button ${JSON.stringify(buttonId)}; its buttons: ${message.card.buttons.map((b) => b.id).join(", ")}`);
  const wait = target.group
    ? oneOf(params, "wait", ["none", "sent"] as const, "none")
    : oneOf(params, "wait", ["none", "sent", "delivered"] as const, ctx.mode === "one-shot" ? "sent" : "none");
  const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
  const result = await node(ctx).pressButton({ linkId: target.linkId, messageId: message.id, buttonId });
  if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error, result.paced ? { paced: true } : undefined);
  const replyId = result.messageId ?? null;
  const answer = { [where]: target.id, messageId: message.id, button: button.id, label: button.label, replyId };
  if (!replyId) return answer;
  if (target.group) {
    const edges = wait === "sent" ? await waitForGroupFrame(ctx, target.id, replyId, undefined, ms) : node(ctx).groupTaken({ groupId: target.id, messageId: replyId });
    return { ...answer, edges };
  }
  const reply = wait === "none" ? (await node(ctx).getMessages(target.linkId)).find((m) => m.id === replyId) : await waitForMessage(ctx, target.linkId, replyId, wait, ms);
  return { ...answer, delivery: reply?.delivery ?? null };
}

export const BUTTON_METHODS: Record<string, Method> = {
  /** WISP 406 · Message Buttons: a press on a button of someone else's message, as the app's tap. */
  "button.press": pressButton,
  /** WISP 406 · Message Buttons: the answer chosen on a question of mine, its buttons closed, or its text changed. */
  "button.update": updateButtons,
};
