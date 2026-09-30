---
section: Fixed / Calls
---
- A call placed from the headless CLI no longer fails when libdatachannel refuses its answer twice in a row (seen on Linux arm64): the CLI offers again up to three times, with a short wait before each, and the call connects on the same audio socket.
