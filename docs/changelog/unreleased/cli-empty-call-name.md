---
section: Fixed / CLI
---
- `call hangup`, `call answer`, `call flush` and `call pipe` refuse an empty call name (a usage error), and so do their socket methods (`bad_request`). Before, `ghostly call hangup "$CALL"` with nothing in `$CALL` hung up, or declined, whatever call was on. Left out, they still take the only call.
