---
section: Fixed / Calls
---
- A CLI call with a TURN server in its profile carries the relay's address in its offer and answer when that server is far away. The CLI waited for its public address only, so a TURN server 100 ms or more away gave its relay too late, and on networks where only the relay connects the call failed.
