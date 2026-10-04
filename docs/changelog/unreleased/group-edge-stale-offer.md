---
section: Fixed / Groups
---
- A private group member whose app restarts more than once no longer waits about 40 seconds now and then to connect again. After the second restart, the app could answer an old connection offer that another member had already given up, and waited for that attempt to time out.
