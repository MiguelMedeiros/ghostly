---
section: For developers
---
- The merge train reads CI's runs on a commit, and each run's jobs, once per run of the train. For a queued pull request waiting on its fast tier it asked GitHub for the same runs list twice and for the newest run's jobs twice, 7 calls per pull request per run; it is 5 now, so a long line reaches the queue app's hourly budget later. The cancel of a boarded pull request's own CI still reads the runs afresh.
