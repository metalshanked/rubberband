# Third-Party Notices

Rubberband's own source code is licensed under the MIT License. That license
does not relicense third-party MCP apps, npm packages, services, APIs, data
sources, or generated artifacts used with Rubberband.

## MCP Apps

The default `mcp-apps.json` references these external MCP app repositories:

| App | Source | Upstream license |
| --- | --- | --- |
| Elastic Dashbuilder | `https://github.com/elastic/example-mcp-dashbuilder` | Elastic License 2.0 |
| Elastic Security | `https://github.com/elastic/example-mcp-app-security` | Elastic License 2.0 |
| Elastic Observability | `https://github.com/elastic/example-mcp-app-observability` | Elastic License 2.0 |
| Trino Visualization | `https://github.com/metalshanked/mcp-app-trino` | MIT License |

These apps are installed into `mcp_apps/` by `npm run mcp:install` or during
the default Docker build. `mcp_apps/` and `mcp-apps.installed.json` are generated
local/runtime artifacts and are not part of Rubberband's MIT-licensed source
tree.

Docker images built with the default `Dockerfile` include the installed MCP app
code. Such images should be described as Rubberband plus bundled third-party MCP
apps, not as an all-MIT distribution.

When changing `mcp-apps.json`, review each upstream license and update this file
if the default/optional app set changes.

## npm Dependencies

Rubberband uses npm dependencies whose licenses are declared in their package
metadata and recorded by `package-lock.json`. The direct dependency set includes
MIT, Apache-2.0, BSD-2-Clause, ISC, and related permissive licenses. Transitive
dependencies may add other notice requirements.

Before publishing a release artifact or container image, generate a fresh
dependency notice report from the exact lockfile used for the build.
