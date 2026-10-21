---
section: Fixed / Groups
---
- A bot that asks a question with answer-once buttons in a long group no longer reads the group's whole history for every member's answer to check whether that member already answered: it reads it at the first answer only. Before, 255 answers handed back at once in a group of 10,000 messages took about 15 seconds to take in on the CLI instead of half a second.
