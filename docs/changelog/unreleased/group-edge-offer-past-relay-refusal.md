---
section: Fixed / Groups
---
- A private group's connection to a member no longer loses its newest offer or answer when a relay refuses it as no newer than the copy it holds (`409 Conflict` in the console): the packet goes again at once, dated past that copy, and a connection that starts again (on a VPN, after WebRTC gave up) dates its packets past its last ones. Before, the connection could wait minutes for a later attempt to get through.
