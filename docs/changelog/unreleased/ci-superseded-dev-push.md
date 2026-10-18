---
section: For developers
---
- The first pull request of a batch the merge train lands on dev no longer pays a full CI run of its own: its run started before the next push arrived, so nothing cancelled it, and it tested a tree dev left seconds later. A push to dev whose tree no green run tested now looks at dev's head (once more after 15 s): when dev already holds a newer commit above it and CI has a push run for that commit, it runs only Tauri Backend, as a tested tree does. A landing that stopped there, a force push or any doubt still runs everything. On 2026-10-18 this was 5 batches in 5 hours, about 280 Linux and 30 macOS runner-minutes.
