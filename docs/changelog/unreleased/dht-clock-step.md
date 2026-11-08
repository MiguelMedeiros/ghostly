---
section: Fixed / Chat
---
- In a chat that sends over the DHT only, setting the device clock back (or a clock that ran ahead being set right) while a text waits for its receipt no longer holds every later text of that chat as "waiting" for as long as the clock moved. The first text is published again at its usual pace and gives up after its five minutes, as before, and the next text goes then. A contact that is away is also no longer read every 4 seconds for most of an hour after such a change.
