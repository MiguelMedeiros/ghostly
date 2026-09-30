---
section: For developers
---
- CI reads whether a pull request is a draft from GitHub when a run starts, not from the event that started it. Pushing and then leaving draft a second later no longer leaves a red CI Success that only a manual rerun cleared: whichever of the two runs survives plans and checks the pull request as it is now.
