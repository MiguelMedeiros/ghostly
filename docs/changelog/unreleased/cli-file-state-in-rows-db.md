---
section: Fixed / CLI
---
- A daemon holds less memory for the files it has sent and received. Each file's transfer state now lives in `rows.db` with the messages, instead of in memory for good: with 10,000 files the store held about 24 MB of heap and now holds about 13 MB. A profile moves the states there at its first start after the update. The file records themselves stay in memory, since a small file can be kept whole in its record.
