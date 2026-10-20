# meshHubCount "held back" failure in the merge train (PR #3583)

## Verdict

Not a regression in this PR's code, and not a timing flake. The failing test came from dev (it is not on this branch
yet). It runs one fixed stream of held reads and writes (`seededRandom(7)`), drawn once for every background request
of every app. Any change in how many requests the 19 joins make moves which reads and writes are held afterwards. The
merged tree lands on one of the streams where the test fails, and dev, on other streams, fails this test too.

No code or test changed. The bound was **not loosened**: the bound that failed (mean of minutes 3-8 <= 8) is never
exceeded on dev alone (highest dev mean 7.83 over 40 streams). Only the test's other bound, last minute <= 8, is
exceeded on dev (5 of 40 streams).

## Numbers

The real test file, 10 runs per side, `--maxWorkers=2`. Each side gives the same result every run:

| tree | runs | held-back test | hubs per minute (minutes 1-8) | mean of 3-8 | background reads / writes |
|---|---|---|---|---|---|
| origin/dev 965165dd7 | 10 | 10 passed | 6 6 6 6 7 6 5 5 | 5.83 | 2018 / 951 |
| origin/dev + branch (merged) | 10 | 10 failed | 6 6 7 7 11 8 7 9 | 8.17 | 1527 / 524 |

The merged numbers are CI's numbers exactly (`expected 8.166666666666666 to be less than or equal to 8`). The other two
tests in the file read `6 6 6 6 6 6` on both trees.

The same scenario over hold streams `seededRandom(1..40)` per side (probe without assertions; the test's bounds applied
afterwards):

| tree | mean of minutes 3-8 (avg over 40, sd) | highest mean | per minute, avg over 40 | mean > 8 | last > 8 | max > 12 | streams failing the test |
|---|---|---|---|---|---|---|---|
| dev | 6.85 (0.57) | 7.83 | 6.33 6.42 6.50 6.83 8.45 7.53 6.30 5.50 | 0 | 5 (seeds 14 15 16 20 29) | 0 | **5 / 40** |
| merged | 7.13 (0.55) | 8.33 | 6.38 6.40 6.55 6.97 8.18 7.75 6.90 6.45 | 2 (seeds 4 7) | 6 | 0 | 7 / 40 |

- Dev fails the test on 5 of 40 hold streams, and the branch on 7 of 40. Seed 7 passes on dev and fails on the branch.
- The averages are 0.28 hubs apart (about 2 standard errors). The gap is in minutes 7-8, when dev drops below where it
  started (5.5). Minutes 1-4 are the same on both trees, and the minute-5 spike is a little lower on the branch.

## Why the PR's code does not elect more hubs

- Stepping up and down (`MeshHubs.tick`, `full`, `counted`, `publish`) is dev's code. The branch's only change in
  `meshHubs.ts` is `passOn` calling `session.handOnTo`, which differs from before only for a `group-commit` frame.
- What the PR adds to `GroupSession` (`handOnTo`, `handOnAgain`, the `ask(from)` on a second copy of a commit) acts
  only on a commit, or when a member lacks the top epoch's secret. In the measured minutes nobody commits.
- A member without the secret has no `rendezvous` and cannot be a hub, so I checked whether dev's test passed only
  because the bug left members out. It did not: with a per-minute count of members whose view has `canSend` false,
  **0 at every minute on both trees, seeds 1-16**. Both trees have the same pool of possible hubs.
- So the PR only changes what the joins leave behind (fewer secret requests, a different count and order of background
  requests). That moves which requests the shared 75 % hold stream holds afterwards.

## What would make it pass (not done, your call)

- The test is a one-stream sample of a noisy process, and dev fails it on about 1 stream in 8. Any change to request
  order during joins can turn it red the same way. Options:
  - Run the scenario on a few streams and bound their average (about 3x the 18 s).
  - Draw the hold decision from (app, key, world time) instead of one shared stream, so unrelated requests don't move it.
  - Loosen the "last minute" bound to `maxHubs + 1`. Dev alone goes over the current one, but that alone does not fix
    seed 7 on the branch, which also fails the mean bound.
- This belongs with dev's test (added in the hubs-on-real-readings fix), not with this PR's fix.

## Not done

- **The merge of origin/dev was not made**: `git merge origin/dev` (and `git merge --no-edit`, `git merge-tree`,
  `git fetch`) were refused here as "requires approval". The merged tree above was built outside the worktree:
  `/tmp/issue-1738-lab/export.mjs merged` writes packages/{core,browser} of origin/dev 965165dd7 with the branch's
  files applied 3-way (`git merge-file`; only `meshHubs.ts` was changed on both sides, and it merged clean). The merge
  itself still needs to be run (`git merge origin/dev`). dev also adds a `result.md` at the root, so this file will
  conflict with it (add/add).

## Commands

- `node /tmp/issue-1738-lab/loop.mjs dev 10`: 10/10 runs, 3/3 tests passed.
- `node /tmp/issue-1738-lab/loop.mjs merged 10`: 10/10 runs, 1 failed / 2 passed, every run the CI failure.
- `node /tmp/issue-1738-lab/seeds.mjs dev|merged` (seeds 1-40) + `stats.mjs`: the table above.
- `node /tmp/issue-1738-lab/loop.mjs wt 3`: the branch as it is (unmerged; its meshHubCount has only the first test),
  3/3 passed.
- `npx vitest related --run --maxWorkers=2 --root packages/browser src/engine/meshHubs.ts ../core/src/groupSession.ts`:
  328 files passed, 16 skipped; 3962 tests passed, 42 skipped.
- `npx vitest related --run --maxWorkers=2 --root packages/core src/groupSession.ts`: 74 files passed, 1 skipped;
  1126 tests passed.
- `npm run typecheck`: clean.
- The OSV job (follow-redirects 1.16.0) was left alone, as asked.
