# WISP video lessons

One short lesson per WISP (3 to 6 minutes), narrated by Miguel, plus cuts for
social media. Every lesson follows the same six scenes so pieces can be reused
across lessons, trailers and posts.

Nothing here is published until a recording exists. The reader shows a player
only when a WISP has `video` metadata (see "Wiring a finished video").

## The six scenes

| # | Scene | Length | What it does | Reusable as |
|---|---|---|---|---|
| 1 | Opening | 10-15 s | Boo and Casper, the WISP number and one-line benefit | Social hook |
| 2 | Problem | 30-45 s | The human situation this piece solves, without jargon | Social cut |
| 3 | The piece | 45-60 s | The contract: what it promises, what it doesn't, where it sits on the composition board | Developer page |
| 4 | In the app | 45-90 s | A real screen recording of the feature (development builds labelled as such) | Product cut |
| 5 | How it works | 60-120 s | Wire-level walk-through: records, frames, capability names, limits | Deep-dive |
| 6 | Next step | 10-20 s | Where to read the document, the code path, and a related WISP | End card |

Rules for every lesson:

- Say the availability out loud, with the site's levels (`lib/status.ts`): *available* (and in which release), *planned* or *research*. "Draft" is about the document, not the feature.
- Show real screens for scene 4. If a feature can't be recorded, say so and use the site illustration, labelled "illustration".
- Name limits in scene 5 (sizes, time windows, both-online requirements, which clients).
- No invented users, partners, metrics or dates.
- Record English first; Portuguese narration reuses the same picture edit.

## Script template

Copy this block to `wisp-<id>-<slug>.md`.

```md
---
wisp: "<id>"
slug: "<file slug>"
title: "<WISP title>"
availability: available | planned | research
duration: "~4:30"
status: script | recorded | edited | published
---

## 1. Opening (0:00-0:12)
Picture:
Narration (EN):
Narração (PT):

## 2. Problem (0:12-0:50)
Picture:
Narration (EN):
Narração (PT):

## 3. The piece (0:50-1:50)
Picture: /developers#compose with <blocks> raised
Narration (EN):
Narração (PT):

## 4. In the app (1:50-3:00)
Recording: <client, build, chat profile>
Narration (EN):
Narração (PT):

## 5. How it works (3:00-4:10)
Picture:
Narration (EN):
Narração (PT):
Limits to say:

## 6. Next step (4:10-4:30)
End card: WISP link · code path · related WISP
Narration (EN):
Narração (PT):

## Social cuts
- 30 s: scenes 1 + 2 + end card
- 60 s: scenes 1 + 4 + end card
```

## Wiring a finished video

Put the file and its poster, with the same name, where the site serves them
(for example `website/public/videos/wisp-800.mp4` and `wisp-800.jpg`), then add
one row to the header table of the WISP itself, in `docs/wisps`:

```md
| Video | [Watch](https://ghostly.tools/videos/wisp-800.mp4) |
```

`npm run sync:references` reads it and the reader shows the video above the
document. Chapters are not read from the header yet.

