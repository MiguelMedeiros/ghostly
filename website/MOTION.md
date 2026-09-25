# Motion guide

How things move on ghostly.tools. Every animation takes its curve, duration and
spring from `lib/motion.ts` (CSS mirrors them as `--ease-*` and `--dur-*` in
`app/site.css`). If a new animation needs a value that isn't there, add it there
first, with a sentence saying what it is for.

## Principles

1. **Motion explains.** Something moves because the copy beside it names it.
   If nothing on screen is about it, it stays still.
2. **One thing at a time.** Within a beat there is one subject in motion; the
   rest waits, dims or has finished. Two things never cross paths.
3. **The subject leads, props follow.** The ghost or the object the sentence is
   about moves first; its captions, lines and highlights arrive 60 to 120 ms after.
4. **Arrive soft, leave quick.** Entrances use `EASE.out` (fast start, long
   landing); exits use `EASE.in` and take about two thirds of the entrance.
   Things travelling on their own (loops, demos) use `EASE.inOut`.
5. **Scroll belongs to the reader.** We never take the scroll over, snap it or
   slow it down. We smooth what the scroll drives, not the scroll itself.
6. **Every frame is a frame.** Any paused point of a scene must read as a
   picture: nothing half-clipped, no text mid-fade across other text, nothing
   under the nav.

## Tokens

| Token | Value | Use |
|---|---|---|
| `EASE.out` | `0.22, 1, 0.36, 1` | Arriving, settling. The default. |
| `EASE.inOut` | `0.65, 0, 0.35, 1` | A trip from A to B in a loop or a demo. |
| `EASE.in` | `0.55, 0, 1, 0.45` | Leaving. |
| `DUR.xs` | 0.18 s | Hover and press feedback. |
| `DUR.sm` | 0.32 s | A chip, a caption swap. |
| `DUR.md` | 0.6 s | A card or panel entering. |
| `DUR.lg` | 0.9 s | A large element, a scene fading in. |
| `DUR.beat` | 1.8 s | One story beat played in full (cards mode, loops). |
| `STAGGER` | 0.07 s | Between siblings entering in sequence. |
| `SPRING.scrub` | 170 / 34 / 0.55 | Anything driven by scroll (settles ≈ 0.35 s). |
| `SPRING.actor` | 120 / 26 / 0.8 | The ghosts: weight, a little overshoot. |
| `SPRING.ui` | 380 / 32 / 0.6 | Small interface elements. |

## Scroll-driven scenes

- Read progress through `useScrub(scrollYProgress)`, never the raw value. A
  wheel tick then becomes a glide, and a large jump (an anchor link, a reload
  mid-page) is taken at once instead of swept through.
- Place beats with `useStep(p, step, n, [from, to], out)`
  (`components/home/stage.tsx`). A beat occupies a range inside its step; keep
  at least 0.1 of the step between the end of one beat and the start of the
  next so a reader who stops scrolling lands on a finished picture.
- Every chapter reserves p 0 to 0.06 to arrive and 0.94 to 1 to leave; its picture
  and copy fade in over 0 to 0.04 and out over 0.90 to 0.94, so the hand-off between
  chapters happens on the bare backdrop with only the two ghosts on it.
- Actors live in the act backdrop and move only between poses in
  `components/story/poses.ts`. The exit pose of a chapter is the entry pose of
  the next.
- A chapter's picture never sits on its copy. `components/story/framing.ts`
  gives each chapter a framing for the window: the whole picture (and the act's
  actors while the chapter plays) moves away from the copy panel, and scales
  down only when there is no room to move. It reads the chapter's drawn area
  from `ART`: when a scene gains something that reaches further, widen its box
  there. `npm run test:e2e` (Playwright, `e2e/scene-overlap.spec.ts`)
  fails on any shape touching the copy, at widths 320 to 1920 in four shapes.
- Windows taller than they are wide get the cards layout, like phones.
- For any range that depends on state (orientation, locale), use the function
  form of `useTransform`: motion turns array ranges on scroll values into a
  native scroll animation fixed at mount.

## Loops and demos (developer page, wallet deck)

- A loop runs 10 to 16 s, split into named phases of 2 to 4 s each; each phase has a
  caption of 2 to 4 words that changes with it.
- Phases move with `EASE.inOut`; the last phase holds a complete frame for at
  least 1.5 s before the loop restarts with a cross-fade of `DUR.md`.
- Pause on hover and on keyboard focus; after a click on a control, hold the
  chosen state for 12 s, then resume.
- Only run while at least half of the element is on screen.

## The swarm (page changes and long jumps)

`components/site/GhostSwarm.tsx`: a flock of 30 small ghosts rises over the
page (0.42 s, `EASE.out`, staggered left to right), holds while the change
happens underneath, and leaves up and to the right (0.52 s, `EASE.in`).

- It plays on internal link navigation and on jumps longer than 1.5 viewports
  on the same page (`jumpTo()`: the story rail's marks, the logo on the page
  you are on). Shorter jumps are a smooth scroll.
- It never plays on ordinary scrolling, in either direction.
- The flock is the only thing moving while it is on screen; the page under it
  changes in one step (no rewinding of scenes).
- Reduced motion: no swarm, the change happens at once.
- Add `data-no-swarm` to a link that must navigate without it.

## The story rail

`components/story/StoryRail.tsx` + `app/rail.css`: the home page's chapter
timeline, docked at the bottom of the screen. It is furniture, not a subject,
so it rests at half opacity in muted greys, lights up while you scroll, point
at it or tab into it, and settles back 1.2 s after the last scroll event
(`DUR.md`, `EASE.out`). A soft wash of the page colour sits under it so text
scrolling past fades out instead of meeting the dots. It hides near the top of
the page and once the footer is within 120 px. On phones (≤ 640 px) only a
2 px progress hairline is drawn. Reduced motion: no transitions, and scrolling
does not light it.

## Devices

| Mode | Who | What moves |
|---|---|---|
| Film | Desktop with a fine pointer | Pinned acts, scroll-scrubbed through `useScrub`. |
| Cards | Touch devices, viewports ≤ 860 px and upright windows | Each step is a card; its scene plays its beat once (`DUR.beat`, `EASE.out`) when it scrolls into view. |
| Stills | `prefers-reduced-motion` and no JavaScript | One finished frame per step; loops show their final frame. |

The layout script in `app/layout.tsx` sets `html.calm`, `html[data-orient]` and
`html[data-touch]` before the page paints, so CSS lays out the right mode at
first paint.

## Performance

- Animate `transform` and `opacity` only. No `filter` or `box-shadow` on things
  that move every frame; halos are gradients drawn once.
- Scale SVG groups about the viewBox origin (`VIEW_BOX_ORIGIN`) whenever the
  group is positioned by its top-left.
- Idle loops (bob, blink, twinkle) pause when their section is off screen
  (`[data-inview="false"]`).

## Before you ship a change

- `npm run build && npm run test:e2e`: no picture on its copy, no ghost cut
  by the window or the nav (CI runs it too).
- `node .spine.mjs <out> 1440` and `node .spine.mjs <out> 390`: look at every
  frame; no overlap, nothing under the nav, text ≥ 12 px on desktop and 11 px
  on phones.
- `node .modes2.mjs <out>`: reduced motion and no-JS read as an article.
- Scroll the page with a trackpad and with a mouse wheel: nothing should step,
  stall or snap.
