# Security Policy

## Reporting a Vulnerability

Do not open a public GitHub issue for security reports.

Email **nick@thegoodguys.la** with:

- a short description of the issue
- impact and affected deployment shape
- reproduction steps or proof of concept
- any logs or screenshots with secrets redacted

Response targets:

- acknowledgement within 48 hours
- severity triage within 5 business days
- coordinated remediation plan for confirmed issues

## Supported Versions

| Version | Supported |
|---|---|
| Latest `main` | Yes |
| Older releases | Best effort |

## Disclosure Expectations

- Give us reasonable time to investigate and ship a fix before public disclosure.
- Avoid accessing, modifying, or exfiltrating data that does not belong to you.
- Avoid disrupting shared infrastructure or customer systems while validating a report.

## Scope

This policy covers the code and docs shipped in this repository:

- MCP server
- Docker Compose setup
- Postgres schema and migrations
- public examples and docs

Out of scope unless explicitly provided by this repo:

- third-party providers you configure yourself
- your network perimeter and host OS
- credentials leaked outside the repository

## Local Development Defaults

The quickstart ships with **local-development credentials on purpose** so
`docker compose up` works with zero configuration:

- Postgres user/password `brain` / `brain`, and a seeded `localdev` API key.
- These are published in `docker-compose.yml`, `.env.example`, and the docs.

**Do not use these in production.** Before exposing Myco beyond your machine:

- Override the defaults via environment variables — `docker-compose.yml` reads
  `${BRAIN_WORKSPACE_ID}`, `${BRAIN_API_KEY}`, and you can set
  `POSTGRES_PASSWORD` for the database. Put real values in a `.env` file and
  **never commit it** (`.env*` is gitignored).
- Note that the quickstart binds Postgres to host port `5432`. Don't expose
  that port on an untrusted network.

## Hardening Notes

Myco Brain is designed so you can keep the source of truth in your own Postgres.
That reduces third-party exposure, but you are still responsible for:

- securing database access (change the default `brain`/`brain` credentials)
- rotating keys
- isolating production environments
- reviewing optional provider integrations before enabling them
