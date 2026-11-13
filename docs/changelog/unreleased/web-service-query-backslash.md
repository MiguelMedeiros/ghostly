---
section: Fixed / Chat
---
- A contact's shared app whose page asks for an address with a `\` after the `?` (a Windows path such as `/api?path=C:\Users`) now gets its answer: the request was refused as a bad path. A `\` before the `?` is still refused.
