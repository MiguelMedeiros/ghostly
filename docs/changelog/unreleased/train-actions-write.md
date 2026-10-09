---
section: For developers / CI
---
- The merge train's workflow asks the queue app for "Actions: write", so the train can cancel a boarded pull request's own full CI run and the runners go to the batch. If the app has only "Actions: read" it falls back to that token (CI read from ci.yml's run, no cancelling, one line in the log), and without Actions at all to the check-runs token as before.
