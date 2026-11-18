---
section: Fixed / Transports
---
- Choosing HyperDHT (or Iroh) for a chat on DHT only answers as soon as that transport's listener is up, instead of
  also waiting for the other one: with Iroh's relay out of reach, `ghostly chat transport <chat> hyperdht` took about
  10 s though the chat was live in 2.
- The last connection choice for a chat is the one kept: a choice made while an earlier one was still settling (for
  example Automatic right after HyperDHT) was overwritten by it a few seconds later, with nothing said.
