---
section: Fixed / CLI
---
- A chat held off its direct link (`chat disconnect --hold`) and then removed or switched through the engine's own calls (`ghostly engine removeLink`, `setChatTransport` or `setDeliveryMode`) now behaves as with `chat remove` and `chat transport`: a removed chat's hold goes with it, and a transport chosen during the hold ends it and stays as chosen. Before, the hold stayed: a removed chat's end of hold was announced (`chat.released`) for a chat that was gone, and a DHT only chosen meanwhile was taken back to the live link when the hold's time was up.
