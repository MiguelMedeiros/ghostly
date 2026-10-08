---
section: For developers / CI
---
- A green batch that the merge train lands on `dev` runs CI at most twice, not once per pull request: pushes to `dev` share one CI concurrency group, so the runs waiting behind one in progress give way to the newest. Before, each squash merge of a batch started the whole CI (about 18 jobs) at once, and a batch of five filled the runners for half an hour.
