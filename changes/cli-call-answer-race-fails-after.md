---
section: Fixed / Calls
---
- A call placed from the headless CLI whose connection fails right after the contact's answer goes in (the same libdatachannel race as a refused answer, ending the other way) now offers again on a new connection. Before, the CLI ended it 3 s later as a hang-up by the contact, and the contact was not told.
