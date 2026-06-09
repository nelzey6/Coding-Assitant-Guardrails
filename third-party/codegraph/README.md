# CodeGraph integration

This repository treats CodeGraph as an optional third-party CLI context provider, not as an MCP dependency. That keeps it usable from Codex, Claude, Pi, and custom agent CLIs.

Expected command on PATH:

```text
codegraph
```

The agentic loop calls `scripts/context/codegraph-context.ps1` to create a markdown artifact for each planner/executor run. If CodeGraph is missing, the artifact says so and the run continues with normal repository inspection.

## Install

Install CodeGraph using the upstream instructions for your environment, then verify:

```powershell
codegraph --help
```

Optional local installer stubs live here so machine-specific install steps can be added without coupling the main harness to one package manager.
