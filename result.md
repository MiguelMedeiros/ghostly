# obsolete

dev already fixes #952's case. A Desktop `files.pick` that the person keeps open longer than the old 60 s
`ANSWER_TIMEOUT` no longer fails on dev.

- origin/dev's `apps/desktop/src/app_sandbox.rs` (from #2338, a9ce49c16) has `PICK_TIMEOUT = 30 min` (line 59), and
  `app_broker` (lines 913-923) waits that long for `files.pick` and `ANSWER_TIMEOUT` (60 s) for everything else.
- Nothing else on the path gives up sooner: the runner's `send` has no timer (its only `setTimeout`s are the
  listener rethrow and the "Not ready" retry), `desktopFiles.ts` calls `linked_files_pick` without one, and
  `linked_files_pick` blocks on the system dialog (`blocking_pick_files` / `blocking_pick_folder`) with no timeout.
- Repro of #952's case on dev: I copied dev's `app_broker` wait (lines 913-923) verbatim into a scratch tokio crate,
  ran it with the clock paused (`cargo run --offline`), had the broker answer after a delay, then deleted the crate:

  ```
  files.pick answered after 61 s -> answer
  files.pick answered after 300 s -> answer
  files.pick answered after 1740 s -> answer
  files.pick answered after 1860 s -> No answer
  storage.keys answered after 61 s -> No answer
  ```

  A pick past 60 s gets its answer on dev. The branch is different only for a pick held open more than 30 minutes:
  the branch waits forever, dev gives up. #2338 chose that bound on purpose ("as long as they take, within reason"),
  so it is not #952's bug.

Nothing changed in the branch: no merge, no code edits, and no tests run, since there is nothing to fix. The CI
failure was not looked into because the PR is being closed. The branch is 1141 commits behind origin/dev.
