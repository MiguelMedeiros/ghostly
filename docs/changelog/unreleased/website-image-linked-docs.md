---
section: For developers
---
- The website's Docker image builds again: its build context now holds the four Markdown files outside `docs/` that a WISP links to (the CLI reference, the proofs and providers lists, the e2e guide). Since the check that refuses a link to a missing file, the image failed to build while CI, which has the whole repository, stayed green. A test now compares the WISPs' links with the image's context.
