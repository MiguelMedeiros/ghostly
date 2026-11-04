# PR #3703: negotiation-tabs.spec.ts:19 timeout

## Merge
`git merge --no-edit origin/dev` (44 commits): a clean merge commit, no conflicts.

## Cause: the branch was incomplete; the spec found a real bug
This is not a timing flake. The old spec failed on this branch 3/3 plain and 3/3 under CPU throttling (rate 4), every
time with `Received: -1` after 45 s. A probe of the built site showed what happens. After a tab is clicked, it has
`style="--p: 0.79"`, but its `.ng-tab-bar` is `display: block; width: 0px`.

`app/dev-steps.css` (loaded on /developers by ProtocolSteps) registers `@property --p { inherits: false; initial-value: 0 }`.
The bar's `width: calc(var(--p, 0) * 100%)` therefore never inherits the tab's `--p`, so it is always 0 px wide. The
branch's CSS fix (removing the top-level copy of `.ng-tab-bar { display: none }`) was needed but not enough. The line still
never drew on any page that also loads dev-steps.css, which is /developers itself. That registration dates from the
website's move to apps/website, so dev has the same bug.

## Fix
- `components/dev/Negotiation.tsx`, `app/negotiation.css`: the progress is now `--ng-p`, matching the demo's `--ng-fade`.
- `e2e/negotiation-tabs.spec.ts`: the test no longer depends on autoplay. It clicks the third tab (retrying until
  hydration makes the click count and the tab is `aria-pressed`). A click plays that scenario and holds it for 12 s. The
  test then polls the tab's own `--ng-p` together with the bar's drawn width (ratio > 0.2 once `--ng-p` > 0.3). What it
  checks is unchanged: the bar of the scenario that plays is drawn.

Red before the fix: on the unfixed build, the new spec logic got `Received: 0` (`--p` above 0.3, bar 0 px wide).

## Runs (website build, `--workers=2`)
- `--repeat-each=10` on both negotiation-tabs specs (desktop + phone): **40/40 passed**. "Shows its progress" passed
  10/10, about 3.8 s each.
- `--repeat-each=10` under CDP `Emulation.setCPUThrottlingRate` 4 (a temp copy of the spec with a fixture that throttles,
  removed afterwards): **20/20 passed**. "Shows its progress" passed 10/10, about 4.1 s each.
- `npm test` in apps/website: 60/60. eslint on the changed files: clean. `npm run typecheck`: clean.
