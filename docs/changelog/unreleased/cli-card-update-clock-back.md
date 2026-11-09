---
section: Fixed / CLI
---
- `task update` and `routine update` now go within 2.5 s after the computer's clock is set back. They waited as long as the clock went back, holding the profile so the bot's other commands answered busy, and the task's update time could read earlier than its start. Past 5 minutes, the refusal now says the device's clock went back instead of naming `startedAt` as a time in the future.
