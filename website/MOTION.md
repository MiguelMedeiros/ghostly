# Motion guide

How things move on ghostly.tools. Every animation takes its curve, duration and
spring from `lib/motion.ts` (CSS mirrors them as `--ease-*`, `--dur-*` and
`--stagger` in `app/site.css`). If a new animation needs a value that isn't
there, add it there first, with a sentence saying what it is for. This file is
the contract; `npm run motion:perf` and `npm run motion:record` are how a change
is checked (see the end).

## Principles

1. **Motion explains.** Something moves because the copy beside it names it.
   If nothing on screen is about it, it stays still.
2. **One thing at a time.** Within a beat there is one subject in motion; the
   rest waits, dims or has finished. Two things never cross paths.
3. **The copy names it, then the picture does it.** The step's words arrive
   first (fast out, base in); the subject starts a moment later. Its captions,
   lines and highlights follow the subject, never lead it.
4. **Arrive soft, leave quick, travel with weight.** Entrances use `enter`
   (fast start, long landing); exits use `exit` and take about half of an
   entrance; something travelling on screen uses `move`. Bodies (the ghosts,
   the pointer ghost) get the one `body` spring on top, so they anticipate and
   follow through instead of sliding.
5. **Scroll belongs to the reader.** We never take the scroll over, snap it or
   slow it down. We smooth what the scroll drives, not the scroll itself.
6. **Every frame is a frame.** Any paused point of a scene must read as a
   picture: nothing half-clipped, no text mid-fade across other text, nothing
   under the nav, and no beat still in motion after its settle point.
7. **Idle is nearly still.** Idle loops (bob, breath, blink, drift, twinkle)
   are slow and small, one or two per view, and they rest when off screen.

## Tokens

| Token | Value | Use |
|---|---|---|
| `EASE.enter` | `0.22, 1, 0.36, 1` | Arriving, popping, settling, hover in. The default (`--ease`). |
| `EASE.exit` | `0.55, 0, 1, 0.45` | Leaving, hover out. |
| `EASE.move` | `0.65, 0, 0.35, 1` | A trip from A to B while on screen: a beat, a loop, a camera move. |
| `DUR.fast` | 0.14 s | Hover, press, focus; a step's copy leaving. |
| `DUR.base` | 0.28 s | A chip, a caption swap, a cross-fade, a step's copy arriving. |
| `DUR.slow` | 0.56 s | A card, a panel, a large element or a scene arriving; the swarm in and out. |
| `DUR.beat` | 1.8 s | One story beat played in full (cards mode, loops). |
| `STAGGER` | 0.06 s | Between siblings entering in sequence; after `STAGGER_MAX` (6) the rest arrive together. |
| `SPRING.scrub` | 170 / 34 / 0.55 | Anything driven by scroll (settles in about 0.35 s). |
| `SPRING.body` | 130 / 19 / 0.9 | Physical things: the ghosts, the pointer ghost. Just under critical damping. |
| `SPRING.ui` | 380 / 32 / 0.6 | Small interface elements. |
| `BEAT` | establish 0.15, settle 0.7 | The shape of a step (below). |
| `HERO` | see `lib/motion.ts` | The opening's timeline (below). |

`ease.enter`, `ease.exit` and `ease.move` are the same curves as functions,
for `useStep(..., curve)` and for maths in a scene. A fade stays linear; a
thing that travels takes `move`; a thing that pops or lands takes `enter`; a
thing that goes takes `exit`.

## Choreography

### The reading order

In a chapter the copy panel changes first and the picture answers. A step's
copy leaves in `fast` on `exit` and the next arrives after it in `base` on
`enter`, rising the last 8 px, so two titles are never half-faded on each
other. The picture's first beat starts at `BEAT.establish` of the step.

### The beat

Every step of a chapter has the same shape, in fractions of the step:

- **establish** (0 to 0.15): the copy is in; the subject of the step arrives or
  is singled out (the rest dims).
- **action** (0.15 to 0.7): the subject does its one thing. If the step has
  two or three things (a card growing, then a link lighting), they run one
  after the other inside this window, never at once.
- **settle** (0.7 to 1): nothing new moves. A reader who stops scrolling here
  sees the finished picture and has time to read.

Stills for the cards layout are taken inside the settle. In cards mode the
whole beat plays once, in `DUR.beat` on `move`, then holds.

### Chapters and hand-offs

- A chapter reserves p 0 to 0.06 to arrive and 0.94 to 1 to leave. Its picture
  and copy fade in over 0 to 0.04 (the copy rising 12 px into place) and out
  over 0.90 to 0.94, so the hand-off happens on the bare backdrop with only the
  two ghosts on it. There is no key light during a hand-off: that was the
  "lighting cut".
- The actors glide between the poses in `components/story/poses.ts` on `move`,
  with a small step the other way first (6% of the glide, gone by a third of
  it) and the `body` spring's follow-through at the end. The exit pose of a
  chapter is the entry pose of the next, so a hand-off is one continuous camera
  move: the camera's push and focal point ease on the same curve.
- An act's pair arrives with the act (fading in from a little above as it pins)
  and leaves with it (rising and fading before the backdrop scrolls away), so
  nothing of them shows on the statement between the acts.
- The ghosts acknowledge each other with a nod (a 12 to 14 unit dip and back
  over 0.03 of the chapter): Boo when Casper arrives, each when their chip
  pops, Casper when the plan lands. A nod is a short key run in the blocking
  table, never a separate animation.
- A chapter's picture never sits on its copy (`components/story/framing.ts`);
  `e2e/scene-overlap.spec.ts` fails on any shape touching the copy.

### The hero

The opening is one timeline (`HERO` in `lib/motion.ts`, mirrored by the CSS in
`app/home.css`), in seconds from the first paint:

1. 0.05: the headline leads, two lines 80 ms apart, 28 px on `enter` over
   0.7 s.
2. 0.32: the lead, the buttons, the micro line and the cue follow as one group,
   14 px on `enter` over `slow`, `STAGGER` apart.
3. 0.7: Boo arrives from 70 units below his place on the `body` spring, fading
   in as he rises.
4. 1.7: his line is typed, 30 ms a character; the bubble's box fades in with the
   first character.
5. 3.6: the "Follow Boo" arrow nudges twice and rests.

Idle: Boo bobs 8 px with a 1.5% breath over 4.2 s and blinks every 5.3 s; the
network field behind the act drifts 12 px over 28 s and parallaxes with the
scroll on its own composited layer; the grid holds still. Leaving: the copy
fades and lifts 48 px over p 0.2 to 0.7 of the hero.

### Loops and demos (developer page, wallet deck)

- A loop runs 10 to 16 s, split into named phases of 2 to 4 s each; each phase
  has a caption of 2 to 4 words that changes with it.
- Phases move with `move`; the last phase holds a complete frame for at least
  1.5 s before the loop restarts with a cross-fade of `slow`.
- Pause on hover and on keyboard focus; after a click on a control, hold the
  chosen state for 12 s, then resume.
- Only run while at least half of the element is on screen.
- The wallet deck on the home is the app's own deck (`components/app/`, synced,
  never edited here); it keeps the app's springs. The site only deals its
  cards every 3.8 s while nobody is pointing at it.

### The swarm (page changes and long jumps)

`components/site/GhostSwarm.tsx`: a flock of 30 small ghosts rises over the
page (`slow`, `enter`, staggered left to right), holds while the change happens
underneath, and leaves up and to the right (`slow`, `exit`).

- It plays on internal link navigation and on jumps longer than 1.5 viewports
  on the same page (`jumpTo()`: the story rail's marks, the logo on the page
  you are on). Shorter jumps are a smooth scroll.
- It never plays on ordinary scrolling, in either direction.
- The flock is the only thing moving while it is on screen; the page under it
  changes in one step (no rewinding of scenes).
- Reduced motion: no swarm, the change happens at once.
- Add `data-no-swarm` to a link that must navigate without it.

### The story rail

`components/story/StoryRail.tsx` + `app/rail.css`: the home page's chapter
timeline, docked at the bottom of the screen. It is furniture, not a subject,
so it rests at half opacity in muted greys, lights up while you scroll, point
at it or tab into it, and settles back 1.2 s after the last scroll event
(`slow`, `enter`). A soft wash of the page colour sits under it so text
scrolling past fades out instead of meeting the dots. It hides near the top of
the page and once the footer is within 120 px. On phones (≤ 640 px) only a
2 px progress hairline is drawn. Reduced motion: no transitions, and scrolling
does not light it.

### The finale and the footer

The finale's pair glides in over 0.9 s on `move`, each line's bubble arrives in
`base` on `enter` and leaves in `fast` on `exit`, Casper's poof is three small
ghosts `STAGGER` apart, and the title's words rise `STAGGER` apart (capped at
six). The footer's pointer ghost (`GhostPet`) is the original: it trails the
pointer with a time-based ease (about 2 s to close most of the distance, 4 s
tired, 8 s asleep), sleeps when you stop and ducks when you reach for it; it
writes its position straight to the DOM and stops its clock once asleep.

### Micro-interactions

One set for everything the pointer can touch: buttons, links, nav links, the
download cards and their buttons, the rail's marks.

- Hover in: `fast` on `enter` (a 1 px lift for buttons, colour and border for
  the rest, an underline drawn in for links). Hover out: `fast` on `exit`.
- Press: back down to 0 and 0.985 scale in 60 ms.
- Focus: the ring appears at once (no transition); the hover state comes with
  it.

## Devices

| Mode | Who | What moves |
|---|---|---|
| Film | Desktop with a fine pointer | Pinned acts, scroll-scrubbed through `useScrub`. |
| Cards | Touch devices, viewports ≤ 860 px and upright windows | Each step is a card; its scene plays its beat once (`DUR.beat`, `move`) when it scrolls into view. |
| Stills | `prefers-reduced-motion` and no JavaScript | One finished frame per step; loops show their final frame; changes cross-fade. |

The layout script in `app/layout.tsx` sets `html.calm`, `html[data-orient]` and
`html[data-touch]` before the page paints, so CSS lays out the right mode at
first paint.

Reduced motion keeps opacity and colour transitions at `base` (a cross-fade is
what the preference allows) and cuts transforms, loops and SMIL; the ghosts
render their still hem. `e2e/motion-calm.spec.ts` checks that every chapter
renders every still with its ghosts and that nothing keeps running.

## Scroll-driven scenes

- Read progress through `useScrub(scrollYProgress)`, never the raw value. A
  wheel tick then becomes a glide, and a large jump (an anchor link, a reload
  mid-page) is taken at once instead of swept through.
- Place beats with `useStep(p, step, n, [from, to], out, curve)`
  (`components/home/stage.tsx`), inside the step's action window.
- Actors live in the act backdrop and move only between poses in
  `components/story/poses.ts`.
- For any range that depends on state (orientation, locale), use the function
  form of `useTransform`: motion turns array ranges on scroll values into a
  native scroll animation fixed at mount.

## Performance

- Animate `transform` and `opacity` only. No `filter`, `mix-blend-mode` or
  `box-shadow` on anything that changes every frame: the key light and the
  ghosts' sheen are plain alpha gradients, the DHT's feathered wedge is six
  faint wedges, not a blurred mask, and the statement's words fade and rise
  without a blur.
- Nothing reads layout in a frame loop. The pointer ghost measures the page on
  resize and writes `left`/`top` itself; nothing calls `setState` per frame.
- `will-change` only where a layer must be its own: the act's network field
  (`.act-field`), the swarm's ghosts, the rail's fill.
- Idle loops rest off screen. `components/site/IdleLoops.tsx` watches every
  outermost ghost, every stage and every particle field, pauses their CSS
  animations (`data-offscreen`) and their SMIL timelines (`pauseAnimations()`)
  while they are out of view, and picks up elements that mount later.
- Anything drawn inside a large SVG repaints that SVG when it changes, so what
  moves every frame on its own (the field's parallax and drift) lives in its
  own layer outside the stage's SVG.
- Scale SVG groups about the viewBox origin (`VIEW_BOX_ORIGIN`) whenever the
  group is positioned by its top-left.
- Targets, measured with `npm run motion:perf` (Chromium headless, software
  raster, 4× CPU throttling on desktop, 6× on the phone): 60 fps with p95 under
  17 ms on every desktop chapter, no frame over 34 ms on the phone's cards.
  Keep the first load light: no new dependency for a motion, no eager image
  beyond the first product screenshot.

## Before you ship a change

- `npm run build && npm run test:e2e`: no picture on its copy, no ghost cut
  by the window or the nav, every reduced-motion still present (CI runs it
  too).
- `npm run motion:perf http://localhost:PORT`: compare with the table in the
  last motion PR; a chapter that drops under 60 fps on the desktop profile
  needs a reason.
- `npm run motion:record http://localhost:PORT out/` and look at the clips
  (`scripts/motion/gif.sh` makes GIFs for a PR): every chapter, the hero, the
  swarm, the deck, the finale, the footer ghost, in film and in cards, and
  the reduced-motion pass.
- Scroll the page with a trackpad and with a mouse wheel: nothing should step,
  stall or snap; stop anywhere and the picture is finished.
