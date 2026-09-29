---
section: Fixed / Calls
---
- `ghostly call pipe` fed a clip that ends (`ffmpeg -t 3 … | ghostly call pipe > heard.raw`) now plays it and keeps writing what the contact says until the call ends. The end of stdin used to close the call's audio socket, so the pipe quit at once and recorded nothing.
