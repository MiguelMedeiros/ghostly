---
section: Fixed / CLI
release: 1.14
---
- Over the daemon's socket, `call.answer`, `call.hangup`, `call.get` and `call.flush` with `"call": ""` (or blank, as an unset variable in a script sends it) now answer `bad_request`, as `ghostly call answer|flush|hangup|pipe ""` already refuses it. It was read as left out, so it hung up, declined, answered or flushed whatever call was on. Leaving `call` out (or `null`) still means the only call.
