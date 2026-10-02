# WISP 4xx: Status Cards for Bots

| Field | Value |
|---|---|
| Number assignment | 4xx; planned, number to be defined |
| Status | Draft |
| Document kind | Profile |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [4xx store-and-forward](4xx-store-and-forward.md), [9xx group mesh](9xx-group-mesh.md), [9xx group community](9xx-group-community.md), [11xx](11xx-headless.md) |
| Implementation | The `sc` field on every text wire of 400 (`packages/core/src/statusCards.ts`), the engine's messages and edits, `ghostly task send` and `task update` in the headless CLI (`task send|update`, `routine send|update`); the task and routine cards and the Tasks button in web, extension and desktop (`apps/ui/src/components/chat/StatusCard.tsx`, `RoutineCard.tsx`, `TasksButton.tsx`); the Tasks board (`apps/ui/src/pages/Tasks.tsx`, `apps/ui/src/lib/taskBoard.ts`) over the engine's card index (`statusCardIndex`) |
| Summary | A bot's task or routine shows as a small card with its progress, and stays current as the bot updates it. |
| Availability | Available |
| Notes | Sent by bots through the headless CLI only; people never create them in the app. Every app, old or new, shows a readable text. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Purpose

People run bots in their chats: a coordinator that opens pull requests, agents that work through a list, routines that run every night. Today a bot says what it is doing with texts, or rewrites one status text with edits ([400](400-chat.md#edits)). A text is hard to scan: where is the task, how far along, is there a pull request, did last night's run pass.

A **status card** is a message a bot sends with a small structured payload beside its text. An app that knows cards shows the card: a title, a thin progress bar, a status, a pull request's size, and more on a tap. Every other reader shows the text. The bot keeps the card current by editing its message. There are two kinds:

- **task**: one piece of work with a status, progress, the step it is on, a short list of steps or log lines, and optionally the pull request it produced.
- **routine**: something that runs on a schedule, with its state, its last run and result, the next run and a few recent runs.

Cards are **display only**. Nothing on a card runs anything, on either side: no buttons that act, no links other than https ones the reader chooses to open. A third kind, `buttons`, puts answers under a bot's question; it is defined in [4xx · Message Buttons](4xx-message-buttons.md), and a press sends a reply, nothing else.

## Who sends them

Only bots. The headless runtime ([11xx](11xx-headless.md)) and any SDK built on the same engine expose sending and updating cards; the app never offers to create one. Any app shows them. This keeps the feature what it is for (a bot telling people how its work goes) and keeps the composer free of a form nobody asked for.

Nothing on the wire says a card came from a bot, and nothing needs to: a card is a message of its author, authenticated as any message is. A person could script one through the CLI; it shows as theirs.

## Options weighed

| Option | Why not, or why |
|---|---|
| A new frame of its own, per path | Every path (the live session, the DHT floor, a hold, a mesh edge, a community) would need a new frame, its own storage, ordering, catch-up and receipts, and older apps would show nothing at all |
| Markup inside the text (a JSON block, a code fence) | Older apps would show the markup; the text's 16 KiB and the DHT's 256 bytes would carry the structure; a person could fake a card by typing |
| **An optional field beside the text of a message, the text being its fallback** (chosen) | The message path already has ids, order, storage, receipts, catch-up and edits on every transport. Older apps ignore an unknown field and show the text, as they do for a link preview (`pv`), a reply (`r`) or a hop count (`fw`). Updates are edits, whose rules exist |

## The card on the wire

The card is a JSON object in a field named **`sc`**, next to the message's text, on every path that carries text with fields of its own. The text (`m`, `text`) is the card's **fallback**: what an app without cards, the DHT floor and a held item show, what the chat list previews and what search finds.

| Path | Where the card goes | Profile |
|---|---|---|
| A 1:1 chat's live session | `sc` on `paired-message`, and on `paired-edit` for an update | [401](401-paired-chat.md#status-cards) |
| The DHT floor | Nowhere. The text goes alone when it fits (256 bytes); an update waits for the live session | [403](403-dht-text.md) |
| A held item | Nowhere. The text is held as any text | [4xx](4xx-store-and-forward.md) |
| A private group | A sealed box `sc` on `group-msg`, and `sc` inside the sealed body of `group-edit` | [mesh](9xx-group-mesh.md#status-cards) |
| A community | `sc` inside the sealed payload, and on the `edit` application frame | [community](9xx-group-community.md#status-cards) |
| A compatibility chat | Refused: it carries text only | [402](402-legacy-chat.md) |

An example task, as it rides beside its text:

```json
{"kind":"task","id":"relay-rotation","title":"Fix relay rotation","status":"running","progress":40,"done":2,"total":5,
 "step":"Running the e2e","branch":"r6a/relay-rotation","startedAt":1790700000000,"updatedAt":1790701200000,
 "pr":{"url":"https://github.com/MiguelMedeiros/ghostly/pull/612","number":612,"additions":123,"deletions":45,"files":7},
 "items":[{"text":"Codec","state":"done"},{"text":"Engine","state":"done"},{"text":"UI","state":"running"}]}
```

And a routine:

```json
{"kind":"routine","id":"nightly-bughunt","name":"Nightly bug hunt","schedule":"every day 01:00","cron":"0 1 * * *","state":"active",
 "lastRun":{"at":1790643600000,"result":"ok","summary":"12 issues checked, 1 PR"},"nextRunAt":1790730000000,
 "runs":[{"at":1790643600000,"result":"ok"},{"at":1790557200000,"result":"failed","summary":"CI flaked"}]}
```

### Fields every card has

| Field | Meaning |
|---|---|
| `kind` | `task` or `routine`. A reader MUST treat a kind it does not know as no card: the message shows its text. |
| `id` | The sender's id for the card, stable across its updates: 1 to 64 characters of `A-Z a-z 0-9 _ . : -`, not starting with `-`. It names the card to the bot and groups a card's messages in the Tasks panel; it is not a message id and the reader trusts nothing because of it. |
| `links` | Optional, at most 4: `{url, label?}`, the url https only, the label at most 40 characters. |

### A task

| Field | Meaning |
|---|---|
| `title` | Required. At most 120 characters. |
| `status` | Required. One of `queued`, `running`, `blocked`, `done`, `failed`, `cancelled`. The first three are **active**. |
| `progress` | Optional. 0 to 100; a reader rounds it and clamps it into the range. |
| `done`, `total` | Optional, together: steps done of total, whole numbers, `total` at least 1, `done` at most `total`. Progress is worked out from them when `progress` is absent. |
| `step` | Optional. What it is doing now, at most 200 characters. |
| `pr` | Optional. `{url, number?, additions?, deletions?, files?, state?, checks?}`: the url https only; the numbers whole, from 0 (`number` from 1), at most 1,000,000,000. `state`: where the pull request stands, one of `draft`, `open` (ready for review), `merged`, `closed`. `checks`: how its checks stand, one of `passing`, `failing`, `pending`. A state or checks a reader does not know is left out; the pull request stays. |
| `branch` | Optional. At most 120 characters. |
| `startedAt`, `updatedAt` | Optional. Milliseconds. |
| `items` | Optional, at most **20**: `{text, state}`, the text at most 200 characters, the state one of `pending`, `running`, `done`, `failed`, `skipped`. Steps or log lines, in the sender's order. |
| `tags` | Optional, at most **3**: short labels (an area, a repository), each plain text of at most 24 characters, none twice. A reader keeps the first three that hold. |
| `parent` | Optional. The `id` of another task of the same sender in the same chat that this task is a part of: an id as above, never the task's own. It only groups: a reader that does not find that task shows this one on its own. |

`pr.state`, `pr.checks`, `tags` and `parent` came after the first cards. They add no status: **a sender MUST NOT invent a status** for what they say (a pull request in review is a `running` task whose `pr.state` is `open`), since a reader drops a card whose status it does not know.

### A routine

| Field | Meaning |
|---|---|
| `name` | Required. At most 120 characters. |
| `schedule` | Required. When it runs as people say it ("every day 01:00"), at most 80 characters. |
| `cron` | Optional. The cron line, at most 64 characters of digits, letters, spaces and `* , / - ? #`. Shown, never run. |
| `state` | Required. `active` or `paused`. |
| `lastRun` | Optional. `{at, result, summary?}`: the result `ok`, `failed` or `skipped`, the summary at most 200 characters. |
| `nextRunAt` | Optional. Milliseconds, at most a year after the reader's clock. |
| `runs` | Optional, at most **10**, newest first: runs as `lastRun`. |

A routine is something the bot runs. The app keeps no schedule, runs nothing and says nothing when a run is late: it shows what the bot last said.

## Bounds

| Bound | Value | Why |
|---|---|---|
| A card's JSON, as sent | **8 KiB** of UTF-8 | With the text's 16 KiB it stays inside every message bound on every path (the 56 KiB a session frame is kept under, a community's text box, a mesh edge's 60 KiB) |
| Lines (step, item, summary) | 200 characters | A card is a glance |
| Title, name | 120 characters | |
| Items, links, runs | 20, 4, 10 | |
| Tags | 3, of 24 characters each | Chips on a card: a few short words |
| Counts | 0 to 1,000,000,000 | |
| Times | A received time no later than 5 minutes past the reader's clock (as a message's, [400](400-chat.md) requirement 10); a next run no later than a year | A peer must not pin a card to "just now" forever; a next run is ahead by nature |
| Edits of a card message | **5,000** | A bot updates a long task often; a text keeps its 100 ([400](400-chat.md#edits)) |
| Links | https, at most 512 characters, no user or password in them, no spaces or control characters | |

## The reader's rule

A reader MUST keep the message whatever its card says. It MUST drop the card, and show the text, when the card is not an object, its JSON passes 8 KiB, its kind is unknown, or its id, title or name, status, schedule or state does not hold. Every other field that does not hold is left out, lists are cut to their bound, numbers clamped into their range, and every string cleaned as a name is ([401](401-paired-chat.md#name-and-picture)): runs of space and line breaks become one space, control, invisible and direction characters go, and it is cut to its bound. An item's unknown state reads as `pending`. Ghostly keeps this rule in `readStatusCard` (`packages/core/src/statusCards.ts`).

A reader MUST show a card's strings as plain text, never through the message renderer ([400](400-chat.md#message-text)): no Markdown, no mentions, no parser cards, no link found in a line. Links are only the card's own https ones, each shown with its host.

## The sender's rule

A sender SHOULD refuse, rather than send, anything a reader would drop, cut or clamp: an unknown status, a link that is not https, a list or line past its bound, a time in the future. A bot then learns at once, and nothing it said is lost on the way. Ghostly keeps this rule in `checkStatusCard`, and the engine applies it to every card it is asked to send.

## The fallback text

The message's text is written from the card by the sender's engine (`statusCardText`), unless the bot gives its own. Plain lines, the first naming the card, so it reads well in an older app, in the chat list and in a notification:

```
🔄 Fix relay rotation
Running · 40% · 2 of 5 steps
Now: Running the e2e
PR #612 +123 -45: https://github.com/MiguelMedeiros/ghostly/pull/612
```

```
🔄 Write the codec
Running · 40%
PR #612 +123 -45 (open, checks passing): https://github.com/MiguelMedeiros/ghostly/pull/612
Tags: core, web
Part of: relay-rework
```

```
🔁 Nightly bug hunt
every day 01:00 · active
Last run: ok, 2026-09-29 01:00 UTC · 12 issues checked
Next run: 2026-09-30 01:00 UTC
```

A pull request's state and checks follow it in brackets, only when the card says them; the tags and the parent's id are lines of their own, `Tags:` and `Part of:`. A task's first line starts with its status: ⏳ queued, 🔄 running, ⛔ blocked, ✅ done, ❌ failed, 🚫 cancelled. The `Now:` line is there only while the task is active: a done, failed or cancelled task's last step is not what it does now, and the card does not show it either. There is no drawn bar: characters that draw one read badly in right-to-left text and in a one-line preview. Times are in UTC, since the text does not know the reader's zone. An app that shows the card does not show this text.

## Updates are edits

A bot updates a card by editing its message ([400](400-chat.md#edits)): the whole new text and the whole new card. Everything edits already say holds: only the author edits, the highest edit number wins whatever order edits arrive in, an edit is not a new message (no sound, no unread, no move in the list), and the author sends only the latest version of each message.

- **A card belongs to the version it came with.** An edit carries the card of its version; an edit without one leaves the message a text. This is the rule a link preview follows, and it keeps a message's text and its card in step.
- **More edits.** A message with a card takes up to **5,000** edits; an edit numbered past 100 holds only when it carries a card. A reader that knows cards says so in a 1:1 chat with **`status-card/1`** in `paired-capabilities` ([401](401-paired-chat.md#status-cards)); an author sends an edit past 100 only when both sides list it. In a group an older member drops such an edit and keeps the last text it took.
- **Not on the DHT floor.** An update carrying a card waits for the live session: on the floor the card would read as its text until the next update, and a bot's steady updates would spend the relays' budget. The first message of a card may go on the floor as its text when it fits; the card comes with the next update.
- **At the cap.** A card message that took its 5,000 edits takes no more: the sender refuses the next one (the CLI says to start a new card with `task send`). A new card may reuse the id; the newest message of an id stands for it.
- **One card, no trail.** A reader keeps only the latest card of a message, replaced in place. An update carrying a card adds nothing to the message's history of versions (its text is only the card's fallback), so a message stores one card and its text, whatever the number of updates.
- **Quiet.** An update is an edit: it never rings or plays a sound, never counts as unread, never notifies and never moves the chat in the list, muted or not. The chat list's line shows the new text when the card is the chat's last message, as for any edit.
- **Pace.** The engine keeps its pace for edits (10 in 10 seconds per chat, the latest version only). The headless CLI adds its own: **one update per card every 2.5 seconds**. An update within that time is merged into the next one, which goes when the time is up or when the runtime stops, whichever comes first, so a bot that reports every line of a log spends a few edits, not thousands. A reader does not trust that: it **applies** a card's updates from someone else at most once a second per message (the first at once, then the highest number of those that came meanwhile), so a sender ignoring its pace costs one write and one redraw a second per card. The receive limits of edits still hold beside it.

## Showing a card

- **In the chat.** A card is compact: the title, a thin progress bar, a status dot and word, and for a task with a pull request "+123 −45 · PR #612". A routine is one line, as a bot may post ten: its name, schedule, next run as a relative time ("in 3 h") and a mark for how its last run went (✓ or ✕). Three or more routine cards in a row from one sender fold into one row ("↻ 10 routines · next in 4 min · ✕ 1 failed") that opens on a tap, and opens by itself when something jumps to one of them. A tap, a click or Enter opens it in place (a sheet on a phone) with the steps or recent runs, the current step, the times and the links.
- **The Tasks button.** A chat or group with at least one card shows a Tasks button in its header, with the number of active tasks. It opens a panel with a line saying how many tasks are active and how many routines there are. In a group it has a section per sender, the one with the most tasks going first: its active tasks with their progress, then its routines folded into one line ("10 routines · next in 4 min · ✓ all OK") that opens on a tap to one line per routine. In a 1:1 chat it is one section without a name. Finished tasks come last, folded under "Finished (n)". The panel drops from the button on a wide screen and is a sheet on a phone; it is never taller than the window and scrolls on its own. An item scrolls to its card. The latest message of each card id per author stands for it.
- **The Tasks board.** One page gathers every task card of the profile, from all its chats and groups: the latest message of each card id per author and chat stands for it, as in a chat's panel. The tasks are in columns by status, each with its count: Queued, Running, Blocked, Done, and Stopped, which holds the failed and the cancelled ones. A line says how many tasks are active. A card has two lines: the title on one line (whole on hover, and unfolded while the keyboard is on it) with how long ago it last changed, then at most three chips (the sender, the chat or group, and "PR #612 +123 −45", a link that opens outside the app), with its progress as a thin bar along its foot; the rest (the current step, the steps done, the branch, the files, when it was updated) is behind Details. A click, a tap or Enter opens the card's chat on its message. A finished task stays for a day after its last update; older ones come with "Show older". A column draws fifty cards, with "Show more" for the rest. The board can be grouped by bot or by chat instead, a column each, and filtered by text. With the optional fields: a **Review** column, between Blocked and Done, holds a task that is queued or running while its pull request is `open`; it is there once some task says its pull request's state, and it is not a status (a blocked task stays in Blocked, and a `merged` pull request moves nothing until the bot marks the task done). The pull request's chip carries its checks as a small mark with a text alternative (✓ passing, ✕ failing, ● pending), and its state in its name and in Details. Tags are chips after the others (three chips in all; every tag is in Details), and the board can be filtered by a tag. A task's parts (the tasks that name it as `parent`, however deep) are stacked under it instead of standing in columns of their own, with a summary on it ("2 of 10 done") that opens to a line per part; a part whose parent is not there stands on its own. Routines are not tasks: they are on their own tab of the page, a line each. On a phone the columns are tabs with their counts, one column on screen, and a swipe moves between them. The arrow keys move between cards and columns. The board is read only: there is no drag between columns, and the bot that owns a task changes its status. The way to it is a line above the chat list that is there only while the profile has a card, with the number of active tasks; a profile without bots never sees it. Ghostly reads the cards for it from an index of the messages that carry a card, never from the chats' histories, so it costs the same however long the chats are, and it follows the messages by itself: an update, a deleted message, a deleted chat.
- **Everywhere.** Theme colors, a phone's width, right-to-left text and the keyboard, like every message. Short words; details behind ⓘ.

## Compatibility

An app that shows cards but came before `pr.state`, `pr.checks`, `tags` and `parent` (Ghostly up to 1.0.1) ignores them: its reader builds the card from the fields it knows and drops a card only for the reasons of the reader's rule, none of which an unknown field is. It shows the same card as without them, and no Review column, chips or stacks; the fallback text carries them in words. The tests keep that reader as shipped and feed it such cards.

An app from before cards ignores `sc` on every path and shows the text: a card message reads as a short status text, and updates as that text edited in place. It does not list `status-card/1`, so a 1:1 author stops editing it at the hundredth edit; the text it shows is the last it took. In a private group a card's box is covered by the author's signature over the whole frame after the other boxes, only when there is one, so what an older app signs and checks for other messages stays the same; an older member handing on a card message drops the card box, and a newer reader of that copy shows the text until a whole copy arrives, as with a reply ([mesh](9xx-group-mesh.md#status-cards)).

## Security and privacy

- A card is the author's claim, like its text. Nothing on it is checked against anything outside the chat: a pull request's numbers, a routine's last run and a task's status are what the bot said.
- Display only: a card has no action, and a reader runs nothing because of one.
- Links are https only, shown with their host before they are opened, and opened like any external link of the app. A card's other strings are plain text.
- Every string and list is bounded, and the whole card is 8 KiB at most: a peer cannot make a card cost more to keep or draw than a text.
- A card rides inside what already seals a message on each path: the live session, a mesh epoch key, a community epoch key. The DHT floor and a hold never carry one.

## Conformance

A card of each kind with every field round-trips on each path; a pull request's unknown state or checks is left out, tags past three or 24 characters are cut, a parent that is no id or the task's own is left out, and a sender is refused each; the reader of Ghostly 1.0.1 shows a card with those fields exactly as without them; a card with an unknown kind, a missing title, a status out of the list, or past 8 KiB is dropped and the text shown; oversized lines are cut and lists capped; a non-https link is left out; a received time far ahead is clamped, a next run beyond a year left out; an edit numbered past 100 without a card is ignored, with one it is shown; a 1:1 edit past 100 is not sent to a contact without `status-card/1`; a card's update waits for the live session; an older app shows the text and its edits up to 100; a mesh card handed on by a member keeps its box only with the author's whole signature. Tests: `packages/core/test/statusCards.test.ts`, `packages/core/test/statusCardFields.test.ts`.

## Open decisions

- The number of this WISP.
- An SDK with the same calls as the CLI, for bots that do not run the headless runtime.
- More kinds (a poll's results, a deployment): each is a new `kind`, which older readers show as text.
- Whether a card id should bind across messages (today the latest message of an id stands for it in the panel, and nothing stops two messages from naming the same id).

## Revision log

One file per change in [changes/4xx-status-cards/](changes/4xx-status-cards/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
