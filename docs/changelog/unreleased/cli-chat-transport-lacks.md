---
section: Fixed / CLI
---
- `ghostly chat transport <chat> webrtc|iroh|hyperdht` now refuses a transport the contact's app doesn't have, as the app's Connection menu does: `refused`, "Your contact's app doesn't have WebRTC" (`details.reason` `contact-lacks`). Before, toward a contact running with no WebRTC (a Linux Desktop, a CLI with `GHOSTLY_WEBRTC=0`), the choice was kept and the chat stayed on another transport with nothing saying it never would move. A transport this app isn't running is refused the same way (`app-lacks`, with why, such as "Iroh relay unreachable"), where it answered `engine`, "Transport unavailable".
