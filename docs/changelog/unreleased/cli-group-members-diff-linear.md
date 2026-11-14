---
section: Fixed / CLI
---
- A daemon in big groups no longer spends a share of a core finding who joined or left them. Each change anywhere (a typing start, a message, a delivery mark) compared every group's members against each other: about 3 ms per full community each time, a quarter of a core in four busy ones. The lists are now walked once, about 30 times faster.
