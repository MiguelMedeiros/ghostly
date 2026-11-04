---
section: Fixed / Groups
---
- In a group, members on a fast connection no longer wait for slow ones that asked for a file first. A device sends a file to three members at a time; when all three are taken and someone else asks, the slowest of them now gives up its place after 10 seconds and finishes later from another member. Before, three slow members could hold all three for their whole download: with an 8 MB file and three members four times slower asking first, the fast ones had it after 61 seconds, now after 25.
