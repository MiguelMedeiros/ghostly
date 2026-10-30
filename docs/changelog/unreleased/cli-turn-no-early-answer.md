---
section: Fixed / CLI
---
- With a TURN server in its settings, a call that rings and is declined, missed or cancelled no longer holds a relay on that server for 10 minutes on the callee's side: the answer's connection is made when the call is answered, not while it rings. libdatachannel never gives a TURN allocation back when a connection closes, so a server with a per-user quota refused the next calls' relay and calls that needed it rang but never connected. When the TURN server gives a call no relay address (a quota reached, wrong credentials, no answer), the daemon's log now says so.
