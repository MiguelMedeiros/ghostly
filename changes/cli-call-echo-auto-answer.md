---
section: Fixed / CLI
---
- `examples/call-echo.mjs` works beside `ghostly call auto on`, as the CLI's README shows it. The daemon answered the call first, the example's own answer was refused ("That call is not ringing here"), and the caller heard only silence: no greeting and no echo. The example now takes a call the daemon answered once it connects.
