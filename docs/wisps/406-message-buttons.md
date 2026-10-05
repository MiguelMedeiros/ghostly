# WISP 406: Message Buttons for Bots

| Field | Value |
|---|---|
| Candidate number | 406; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [405 status cards](405-status-cards.md), [902 group mesh](902-group-mesh.md), [903 group community](903-group-community.md), [1100](1100-headless.md) |
| Implementation | The `buttons` kind of `sc` and the press's `b` in a reply (`packages/core/src/statusCards.ts`, `replies.ts`), `buttons/1` in `paired-capabilities`, the engine's `pressButton` and press check (`packages/browser/src/shared/buttons.ts`), `ghostly send --button`, `group send --button`, `button press`, `button update` and the `button.pressed` event in the headless CLI; the buttons and the press line in web, extension and desktop (`apps/ui/src/components/chat/MessageButtons.tsx`) |
| Summary | A bot asks with buttons under its message ("Yes", "No", "Approve"); a tap answers, and the bot learns who pressed which. |
| Availability | Available |
| Notes | Sent by bots through the headless CLI only; people never create them in the app. Every app, old or new, shows the question as text, and an answer as a reply. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Purpose

A bot often asks something with a short set of answers: "Want the $30 one?", "Deploy to production?", "Which plan?". Today the person types the answer, and the bot parses free text. **Message buttons** put the answers under the bot's message. A tap sends the answer, and the bot gets it as a structured event: which message, which button, who pressed.

## Options weighed

| Option | Why not, or why |
|---|---|
| A field of its own beside the text (`bt`) | Every path (the live session, a mesh sealed box and its signature, a community payload, three edit frames) would need it again, with its bounds, and a reader rule for each |
| **A card of kind `buttons` in the status card's field (`sc`)** (chosen) | `sc` already rides every path with its text as fallback, is bounded (8 KiB), is updated by edits and paced on receive ([405 · Status Cards](405-status-cards.md)). A reader from before this kind drops a kind it does not know and shows the text: the fallback this needs, with nothing new on the wire |
| A press as a new frame, per path | A frame of its own on each path, its storage, catch-up and receipts, and a gate so older apps would not get what they cannot read |
| **A press as a reply naming the button** (chosen) | A reply already rides every path, with ids, order, receipts, resend, holds and catch-up. Its text is the label, so an app or a bot from before buttons reads an ordinary reply ("Yes" answering the question), which is what a person would have typed |

## The buttons on the wire

The buttons are a status card of kind **`buttons`** in `sc`, beside the message's text:

```json
{"kind":"buttons","id":"ask-30","buttons":[{"id":"yes","label":"Yes","style":"primary","once":true},{"id":"no","label":"No","once":true}]}
```

| Field | Meaning |
|---|---|
| `kind` | `buttons`. |
| `id` | The bot's id for the question, as a card's ([405](405-status-cards.md#fields-every-card-has)). |
| `buttons` | 1 to **6** buttons, in the bot's order: `{id, label, style?, once?}`. |
| `buttons[].id` | What a press names: 1 to **32** of `A-Z a-z 0-9 _ . : -`, not starting with `-`, unique in the list. |
| `buttons[].label` | At most **40** characters, one line, cleaned as a card's strings are. Not the same as another button's label, nor another button's id, ignoring case and spaces at the ends (see below). |
| `buttons[].style` | Optional: `primary` (highlighted), `neutral` (the default, left out), `danger`. |
| `buttons[].once` | Optional, `true`: a press on it answers the question for that person, and their app offers none of the buttons again. A button without it may be pressed again (a "More" or "Refresh"). |
| `chosen` | Optional: the id of the answer the bot took, marked for everyone. |
| `closed` | Optional, `true`: no button takes a press any more. |

Unlike a task or a routine, **the message's text shows with the buttons**: it is the question. It is also what an app without buttons shows, the DHT floor carries and the chat list previews, so a bot SHOULD say in it how to answer in words ("Want the $30 one? Reply yes or no"). The sender's engine writes "Reply: Yes / No" when the bot gives no text. Buttons take no `links`.

### A question asked while the contact's app was closed

The DHT floor ([403](403-dht-text.md)) and a hold ([404 · Store and forward](404-store-and-forward.md)) carry the question **without its buttons**: its text alone, which a person can answer in words. A copy under the same id that comes later on the live session is taken as the one already there, and a question the contact confirmed is never sent again. So the **sender's app restores the buttons live**: a question of its own that went on the floor or into a hold is noted so on its row, and once the chat is live with an app that lists `buttons/1` and both sides offer `edit/1`, it goes again as an **edit of its buttons alone**: the next edit number, the same text, the card as it is now. Its text is unchanged, so the reader keeps no version and shows no edit mark ([Answering and closing](#answering-and-closing)).

- At most once per question, and the note is kept with the message, so a restart sends nothing again. The edit goes through the sender's edit queue ([400](400-chat.md#edits)): only on the live session (a card's edit never goes on the floor), sent again until the contact confirms it, and an edit of the bot's made after it takes a higher number and replaces it; a reader applies the highest.
- A contact whose app does not list `buttons/1` gets none: an app from before buttons (1.0.0) would show the question as edited and still no buttons. The question stays noted, and the buttons go once that contact's app lists `buttons/1`.
- The edit is the sender's app's own, not the bot's: the bot's event stream ([1100](1100-headless.md)) reports nothing for it. Its number counts, so a later edit of the bot's takes the next one and is reported as any edit.
- Groups have no floor and no hold. A copy of a group message another member hands on without its author's whole signature carries no card; the author's whole copy completes it with the card ([902 · Group Mesh § Catch-up](902-group-mesh.md#catch-up)), so nothing is restored there.

The reader's rule is the card's ([405](405-status-cards.md#the-readers-rule)), with these for this kind: a button whose id does not hold, repeats one before it, or has no label is left out; the list is cut to 6; a card with no button left is no card, and the text shows; a `chosen` that names no button and a `closed` that is not `true` are left out; an unknown style reads as `neutral`. The sender's rule refuses all of these instead (`checkStatusCard`).

A typed answer is matched by a button's label or id, ignoring case and spaces at the ends (see [A press](#a-press)), so the sender's rule also refuses two buttons such an answer could not tell apart: a label that repeats an earlier button's label ("Yes" and " yes"), and a label that is another button's id (a button `yes` labelled "No" beside a button `no`). A label that is its own button's id (`yes`, "Yes") is the common case and stays. A reader does not drop a card from a sender that ignored this: it keeps the buttons, and a typed answer takes the first that matches.

## A press

A press is a **reply** to the message ([400](400-chat.md#replies)) whose text is the button's label and whose `r` carries **`b`**, the button's id:

```
{ "t": "paired-message", "id", "ts", "m": "Yes", "r": { "i": <the question's id>, "s": "Want the $30 one?", "f": "recipient", "b": "yes" } }
```

It goes on every path a reply goes: the live session, the DHT floor, a hold, a private group's sealed reply box, a community's payload. It is sealed and authenticated as any message on that path, and only the chat's or group's members read it. A reader drops a `b` that does not hold (not 1 to 32 of the characters above) and keeps the reply. An app from before this revision drops `b` whatever it holds, and shows the reply.

**What the author's app takes as a press.** A reply received is a press when all of these hold: it answers a message of this side's with a `buttons` card; the card is not `closed`; `b` names one of its buttons and the reply's text is that button's label (ignoring case and spaces at the ends); and this person has not already pressed a `once` button of it. A reply whose `b` names one button and whose text says another thing ("No" naming `yes`) is an ordinary reply: what every reader sees and what the author takes never differ. A reply that arrives without `b` (the DHT floor carries a reply's id alone, [403](403-dht-text.md)) or from an app without buttons counts as a press of the button whose label or id its text is, ignoring case and spaces at the ends, marked `inferred`. Anything else stays an ordinary reply. In a group every member reads the press as a reply from that member, so everyone sees who pressed what; the author's app is the one that takes it as a press.

**The presser's app** sends a press only for a message of someone else, with that button, not `closed`, and not answered with a `once` button; and at most **one press a second** per message. Pressing a button of one's own message does nothing. It reads its own replies to the question as the author's app does: a reply typed in words that is a button's label or id is that button's press, so "yes" typed as the answer to a question with a `once` Yes leaves no button to press.

## Answering and closing

The bot marks what it took, or closes the question, by **editing its message** with the card of that version ([405](405-status-cards.md#updates-are-edits)): `chosen` for the answer, `closed: true` so no more presses go. Every member sees the edit.

Unlike a task's card, the text of a question is what people answer, so an edit that changes it is an edit like any text's ([400](400-chat.md#edits)): the reader keeps the version it replaces and shows the message as edited. Only an edit that changes the buttons alone (the answer marked, the question closed) keeps no version and shows no mark. A press drawn compactly ("↩ Yes") stands for the question as the presser saw it: when the question's text is no longer the one the reply quotes, the reply names no button the question has, or its text is not that button's label, the app draws it as any reply, its quote being the question as the presser answered it. An app shows a closed question's buttons disabled, the chosen one marked; it sends no press to a closed question, and the author's app would not take one. A bot SHOULD answer a press (an edit, a reply or both), so the person sees it landed.

## Capability

A 1:1 app that shows buttons lists **`buttons/1`** in `paired-capabilities` ([401](401-paired-chat.md#message-buttons)). Nothing is gated on it: the buttons are a card an older app shows as text, and a press is a reply. It tells a bot whether its contact can press at all (`pressable` in the CLI's answer to `send`). A group has no capabilities per member: some members may answer in words.

## Bounds and pace

| Bound | Value |
|---|---|
| Buttons | 1 to 6 |
| A button's id | 1 to 32 characters |
| A label | 40 characters |
| The card | The card's 8 KiB; a press is a reply, within the text's bounds |
| Presses | One a second per message from the presser's app; the receive limits of messages still hold |

## Showing buttons

Under the bot's bubble, a row of rounded buttons that wraps (two share a row; up to six wrap into rows of two or three at a phone's width), in theme colors, `primary` filled with the accent, `danger` in the danger tone. A tap shows the button as sending, then marks it chosen (✓); a second tap within a second of the last is not taken, and nothing is said of it. A closed question's buttons are disabled; the chosen one stays marked. A press shows in the chat as a compact line ("↩ Yes") on the presser's side, linked to the question. Buttons are real buttons: keyboard, focus ring, screen readers (a group of answers, the chosen one pressed), right-to-left text.

## Headless runtime

`ghostly send <chat> "Want the $30 one? Reply yes or no" --button yes:Yes --button no:No --style yes=primary --once`, and `ghostly group send` the same; `ghostly listen` reports `button.pressed` (chat or group, the question's `messageId`, `button`, `label`, who pressed, and `inferred` when so); `ghostly button press <chat|group> <message> <button>` presses a button of someone else's question, as a tap; `ghostly button update <chat|group> <message> --chosen yes --close` edits the question ([1100](1100-headless.md#message-buttons)).

## Security and privacy

- A press is a reply: sealed and authenticated as any message on its path, from a member of the chat or the group. Nobody outside it can press.
- A bot MUST treat a press as what that person said, no more: check it is allowed to act for them. A label is the bot's own text; a press names only an id the bot chose.
- A bot MUST act on a press once: the runtime may report an event again (a restart, a replay with `listen --since`), so a bot dedupes by the event's `id`. The presser's `name` in the event is what that person or group roster says, not a proof of who they are; `by` (a chat, a member's key) is what identifies them.
- A question's text cannot be changed after an answer without a trace: a new text keeps the old version and shows as edited, and a compact press on a changed question falls back to the reply with its quote.
- Buttons run nothing in the app: a tap sends a reply, nothing else. There are no links, forms or scripts on a button.
- A press reveals, to everyone who reads the chat or group, what the person answered, as a reply would.

## Conformance

A buttons card with every field round-trips on the live session, a mesh group and a community, and on an edit; bad buttons are left out, a card with none left is dropped and the text shown; the sender refuses 0 or 7 buttons, a repeated id, a label that repeats another's or is another button's id (ignoring case and spaces at the ends), a label past 40, an unknown style, a `chosen` naming no button; a press's `b` rides in `r` on every path, an invalid `b` leaves a plain reply, and an older reader keeps `{i, s, f}`; the author's app takes a press only for its own open buttons, once per person for a `once` button, and infers one from a reply's text; the presser's app refuses its own message, a closed question, an answered `once` question and a second press within a second; a question that went on the DHT floor or into a hold gets its buttons as one edit of the buttons alone once live with a contact that lists `buttons/1`, never twice, restarts included, and none to a contact without it. Tests: `packages/core/test/messageButtons.test.ts`, `packages/browser/test/messageButtons.test.ts`.

## Open decisions

- The number of this WISP.
- Private presses in a group (to the author only, as a frame of its own on the author's edge), instead of a reply everyone reads.
- A press that goes over the DHT floor loses its button id; the author's app infers it from the label. Whether a DHT element should carry it.
- Buttons on a task card ("Approve" on a pull request's card).
- Whether the app should hide the press's reply line once the bot's edit marks the answer.

## Revision log

One file per change in [changes/406-message-buttons/](changes/406-message-buttons/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
