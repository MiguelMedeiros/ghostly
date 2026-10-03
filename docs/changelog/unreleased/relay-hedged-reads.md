---
section: Fixed / Everywhere
---
- A slow Pkarr relay no longer holds a pairing back on the web, in the extension and in the headless CLI. When the relay asked has not answered within 1.5 s, the next relay is asked too and the first good answer wins; a relay found slow goes last for a minute, and one that keeps answering slowly is left alone like a failing one ("tripped (slow)" in the log).
