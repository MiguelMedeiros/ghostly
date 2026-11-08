---
section: For developers / CI
---
- While CI Success is red on `dev` itself, the merge train no longer holds a red batch that holds a `queue:priority` pull request, nor such a pull request alone whose own run was red once: the batch is split and the lone one gets its second run, as with a green `dev`. Before, a fix for `dev` that boarded together with other pull requests, or whose run flaked once, became the held one itself, and the line stopped until someone took it apart by hand.
