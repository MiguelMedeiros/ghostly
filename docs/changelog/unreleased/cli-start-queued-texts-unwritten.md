---
section: Fixed / CLI
---
- The daemon starts as fast with texts still queued for an away contact as without them: a start leaves a queued text as it is, so it reads only the newest page of that chat. Before, it wrote each queued text again and then read every such chat whole: with 30 such chats of 1,000 messages, ready in 1.4 to 2 s instead of about 1 s.
