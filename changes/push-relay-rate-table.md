---
section: Security / Everywhere
---
- The reference push relay counts an IPv6 client by its /64, and a full table of counts forgets the client seen longest ago instead of turning every newcomer away. Behind proxies it listens on 127.0.0.1 by default, so only the proxy can set the client's address.
