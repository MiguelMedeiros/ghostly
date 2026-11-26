---
section: Fixed / CLI
---
- Through a daemon, `ghostly usage send --all --wait sent` and `ghostly forward ... --wait sent` to several contacts who are away answer within about one `--timeout`, with each chat's result. They used to wait for each contact in turn and fail as "The daemon did not answer" (exit 4), telling you to restart a daemon that was fine. A `ghostly file send --wait sent` of a large file through a daemon no longer gives up the same way while the file is still copied in.
