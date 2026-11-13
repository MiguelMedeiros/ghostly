---
section: Fixed / CLI
---
- A `ghostly listen --exec` hook now runs on the profile and Ghostly folder the listen was given with `--profile` or `--home`. It got only the environment the listen started in, so the hook's own `ghostly send` acted on the current profile: it failed with "No chat …" (seen only as "--exec exited 3"), or, when that profile had the same chat, answered from the other identity. The hook now gets `GHOSTLY_PROFILE` and `GHOSTLY_HOME` of its listen.
