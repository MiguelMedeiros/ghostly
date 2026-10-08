---
section: For developers / CI
---
- A merge train lands pull requests on `dev` and on `epic/*` branches: a reviewed, green pull request gets the `queue` label, and the train merges up to five at a time in the order they were queued, after one CI run on the batch. A red batch is split until the pull request that breaks it is found, and every queued pull request has a comment with its place in line.
