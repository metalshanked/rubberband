# Contributing

Thanks for taking the time to improve Rubberband.

## Development Setup

Requirements:

- Node.js 22 or newer.
- npm.
- Optional: Docker, for container smoke tests.
- Optional: Playwright browsers, for UI tests.

Setup:

```bash
npm install
npm run mcp:install
npm run dev
```

For development without installed MCP apps, skip `npm run mcp:install`; the app
will still run with an empty tool/app list.

## Checks

Run the focused checks before opening a pull request:

```bash
npm run check
npm run build
npm run test:api
npm run test:e2e
```

Use `npm test` for the normal full local test path. `npm run test:docker` and
`npm run test:live` are optional integration checks that need Docker or real
provider credentials.

## Pull Request Guidelines

- Keep changes scoped to one behavior or cleanup area.
- Match the existing TypeScript and React style.
- Add or update tests when behavior changes.
- Update `README.md` when setup, runtime behavior, or environment variables
  change.
- Update `THIRD_PARTY_NOTICES.md` when default MCP apps or material bundled
  third-party components change.
- Do not commit `.env`, `mcp_apps/`, `mcp-apps.installed.json`, local IDE state,
  generated test output, or local tool state.

## Licensing

By contributing to Rubberband, you agree that your contributions are licensed
under the MIT License.

Do not copy third-party source into Rubberband unless its license is compatible
with the intended distribution and the license notice is preserved. In
particular, Elastic License 2.0 MCP apps may be referenced and installed as
third-party apps, but their source should not be copied into Rubberband's
MIT-licensed source tree.
