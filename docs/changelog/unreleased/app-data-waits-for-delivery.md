---
section: Fixed / Apps
---
- On a link slower than a contact's mini-app sends, the chat's texts no longer wait 0.5 to 2.3 seconds behind the app's data. An app now sends only while at most 64 KiB of its data has not yet reached the contact, and is told `too-fast` past that.
