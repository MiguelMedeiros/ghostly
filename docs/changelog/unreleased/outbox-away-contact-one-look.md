---
section: Fixed / Chat
---
- Texts written to a contact whose app is closed no longer slow the app down while they wait. Each check re-read every older waiting text, so a few hundred of them made each check read the store tens of thousands of times. On the command line and in bots this kept the CPU at 100%: other chats dropped, calls never connected, and the queue was not delivered when the contact came back. Now each check reads the chat once, however many texts wait.
