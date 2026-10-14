---
section: Fixed / Chat
---
- A text within 16 KiB that takes more room once encoded than the contact's app accepts (control characters count six each) is refused when you send it, with "Message too long" and the next step, in the app and in `chat send` (code `refused`). Before, it was taken, never arrived, ended the live connection on every try until it failed after 8, and held the chat's other texts back meanwhile.
