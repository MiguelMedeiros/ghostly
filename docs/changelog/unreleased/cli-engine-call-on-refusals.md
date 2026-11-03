---
section: Fixed / CLI
---
- `ghostly engine removeLink`, and `setChatTransport` or `setDeliveryMode` to `dht`, are refused (`busy`) while a call is on in the chat, as `chat remove` and `chat transport dht` are: the call no longer talks on in a removed chat, or off its live link with a hang-up that never reaches the other side.
