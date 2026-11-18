---
section: Fixed / CLI
---
- An agent catching up on many turns older than the chat's newest 200 messages (a `listen --cursor` bot back after a while, or a busy group) reads the whole history once for them, not once per turn it answers. Each reply to another old turn read the whole history again and hashed every message: 1,000 replies in a 50,000-message chat spent 86 s hashing alone, holding the daemon up to 0.3 s each time.
