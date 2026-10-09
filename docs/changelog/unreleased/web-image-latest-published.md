---
section: Fixed / Self-hosting
---
- The web image's `latest` tag (`ghcr.io/miguelmedeiros/ghostly-web:latest`, what `infra/docker-compose.yml` pulls) moves only once a release is published, and never back to an older version: a release that stayed a draft, or an old tag built again, no longer reaches self-hosters who pull. The image's `/version.json` names the tag's own commit.
