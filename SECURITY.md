# Security Policy

## Supported Versions

Rubberband is currently pre-1.0. Security fixes are made on the default branch
until stable release branches exist.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting if it is enabled for the repository.
If that is not available yet, open a minimal public issue asking for a private
contact path. Do not include exploit details, credentials, tokens, logs with
secrets, or private endpoint URLs in a public issue.

Useful reports include:

- Affected Rubberband version or commit.
- Whether the issue affects local development, Docker, or a shared deployment.
- Minimal reproduction steps.
- Expected impact.
- Relevant sanitized logs.

## Scope

In scope:

- Rubberband server APIs.
- MCP app process launching and environment handling.
- Settings storage, secret redaction, and error explanation flows.
- Docker/runtime packaging controlled by this repository.

Out of scope:

- Vulnerabilities in third-party MCP apps. Report those to the upstream app
  maintainers unless Rubberband's integration makes the issue worse.
- Vulnerabilities in Elastic, Trino, Starburst, OpenAI-compatible providers, or
  other external services.
- Publicly disclosed issues in npm dependencies that are already tracked by
  upstream maintainers.

## Deployment Guidance

- Run Rubberband behind HTTPS outside local development.
- Use least-privilege credentials for Elasticsearch, Kibana, Trino, Starburst,
  and LLM providers.
- Treat MCP apps as executable third-party code. Review their source and license
  before installing, and pin refs for production builds.
- Keep `.env`, generated manifests, installed app directories, and local tool
  state out of source control.
- Avoid `ALLOW_INSECURE_TLS=true` except in local or controlled internal
  environments.
