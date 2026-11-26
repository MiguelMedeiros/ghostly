---
section: Fixed / Relays
---
- A HyperDHT relay no longer drops a browser for not answering its ping while the relay itself has stopped reading that browser for sending past its byte rate (`GHOSTLY_RELAY_BYTES_PER_SECOND`): the answer was waiting behind what the browser had sent. At 128 KiB a second behind one proxy, a browser sending steadily lost every chat's connection through the relay after a minute.
