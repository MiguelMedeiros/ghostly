---
section: For developers / CI
---
- The merge train no longer takes a CI run whose jobs were cancelled part way for a red one: CI Success fails when a job it needs was cancelled, and a pull request alone in its batch got `queue:failed` for it. When no job failed, the train waits for CI or runs it again; a job that did fail still counts.
