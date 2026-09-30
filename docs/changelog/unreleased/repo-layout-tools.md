---
section: For developers
---
- The repository root holds only workspace configs and project documents. Scripts, patches and the shared Vitest settings moved to `tools/` (`tools/scripts/`, `tools/patches/`, `tools/vitest.shared.ts`); the relays and the web app's compose file to `infra/` (`infra/services/`, `infra/docker-compose.yml`, run with `docker compose -f infra/docker-compose.yml up --build -d`); these changelog entries to `docs/changelog/unreleased/`; `CONTRIBUTING.md` and `SECURITY.md` to `.github/`; and the SDK's example adapter to `packages/sdk/examples/adapter/`.
