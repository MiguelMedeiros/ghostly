---
section: For developers
---
- The security autorelease gate refuses a `claude/security-auto-*` branch that carries commits of `dev` that `main` does not have. `dev` holds `main`, so a branch rebased onto `dev` passed the "on top of main" check, and a small unreleased diff on `dev` would have been released with the security fix.
