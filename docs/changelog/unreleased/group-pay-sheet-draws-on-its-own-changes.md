---
section: Fixed / Groups
---
- A group's open ⚡ sheet no longer draws itself again on every change elsewhere in the app. Each change, up to 20 a second while a file moves, drew every member's row again, or the whole payment form while its amount was typed. Now it draws only when a member's link or the wallets change. In a test with 256 members in a community, 200 changes elsewhere caused no draws of the sheet and took 0.3 ms each, down from 3.4 ms. The New group dialog no longer draws on such changes either.
