# CLAUDE.md — Ollama Cloud Usage

Notes for future agents and maintainers. Read this before changing the API layer.

## What this extension does

Shows Ollama Cloud quota (legacy 5h/weekly windows or credit-plan USD balance) in:
- a status bar item (`Ollama Cloud Usage`), and
- a webview panel opened by clicking it.

## Architecture

| File | Responsibility |
|:--|:--|
| `src/extension.ts` | Activation, status bar, command registration, 60s refresh timer, 1s tooltip countdown tick. |
| `src/api.ts` | HTTP requests, response parsing, normalization into `UsageResponse`. |
| `src/usageTreeProvider.ts` | Holds current usage/error/accounts state, builds status-bar text and Markdown tooltip, also implements an (unregistered) `TreeDataProvider`. |
| `src/webviewViewProvider.ts` | Renders the usage panel HTML/CSS/JS. Countdown ticks client-side every second. |
| `src/accountStore.ts` | Multi-account API keys in VS Code Secret Storage; migrates the legacy single-key entry. |
| `src/api.test.ts` | Node test runner tests for parsing/composition. |

`UsageTreeProvider` is **not** registered with `createTreeView`; it is used as the state controller for the status bar and panel. Its tree methods are effectively dead code but must keep compiling.

## Data flow

`UsageTreeProvider.refresh()` → `fetchUsage(apiKey)` in `src/api.ts`:

1. `GET https://ollama.com/api/balance` (required; failure aborts the refresh).
2. Choose long range: `30d` for credit plans, `7d` for legacy plans.
3. In parallel, `GET /api/usage?range=24h&group_by=model` and `GET /api/usage?range=<longRange>&group_by=model` (best-effort; failures only lose model breakdowns).
4. `composeUsage(balance, recent, longUsage)` → normalized `UsageResponse`.

Auth: `Authorization: Bearer <key>`. `normalizeAuthorization()` adds the prefix if the stored key does not already include it.

Rate limit: 10 requests/minute per user (shared across keys/devices). Each refresh makes 3 requests, so do not add more per-refresh calls without revisiting this.

## API contracts (as of 2026-10-20)

### `GET /api/balance`

Legacy plan:

```json
{
  "included": {
    "session": { "remaining_percent": 43.67, "resets_at": "2026-10-20T11:00:00Z" },
    "weekly":  { "remaining_percent": 75.14, "resets_at": "2026-10-26T00:00:00Z" }
  },
  "purchased": { "balance_usd": 0 }
}
```

Credit plan:

```json
{
  "included": {
    "balance_usd": 72.5,
    "allowance_usd": 100,
    "period": { "from": "2026-09-15T09:30:00Z", "until": "2026-10-15T09:30:00Z" }
  },
  "purchased": { "balance_usd": 25 }
}
```

`remaining_percent` is **percent remaining**, so `usage = (100 - remaining_percent) / 100`.

### `GET /api/usage?range=24h|7d|30d&group_by=model`

Time series. `granularity` is `hour` for 24h and `day` for 7d/30d.

```json
{
  "range": "24h",
  "scope": "self",
  "granularity": "hour",
  "group_by": "model",
  "from": "...",
  "until": "...",
  "totals": {
    "request_count": 780,
    "groups": [{ "model": "glm-5.3-flash", "request_count": 548 }]
  },
  "buckets": [
    { "from": "...", "until": "...", "partial": true, "request_count": 5, "groups": [] }
  ]
}
```

- Model groups use `model` (not `name`). Both are accepted by `parseModels()`.
- `usage_usd` is **optional and often absent on legacy accounts**. `SpendUsage.cost_usd` is optional for that reason — never default it to 0 in the UI, or the panel shows a false `$0.00`.
- Older payloads with `activity` / `limits` are still accepted by `parseCloudUsage()`.

## Normalization and window filtering

- `session.models`: if the 24h response has old-style `limits.session.models`, use it; otherwise sum `buckets[].groups` whose `from >= session.resets_at - 5h`.
- `weekly.models`: same for the 7d response using `weekly.resets_at - 7d`.
- `credits.models`: sum the 30d response buckets from `period.from`; fall back to `totals.groups`.
- `spend`: long-range `totals` (cost + request_count + groups), falling back to old `activity`.
- Reset times always come from the server (`resets_at`, `period.until`). There is **no local UTC boundary math** anymore; `src/resetTime.ts` was deleted in 1.1.0. Do not reintroduce it.

## UI mapping

| Data | Status bar | Tooltip | Panel |
|:--|:--|:--|:--|
| Legacy | `5H:x% W:y%` | 5 hour + Week rows | Session / Weekly rows + model lists |
| Credit | `$balance/$allowance` | Credits row | Included credits + 30d model list, purchased credits |
| Long range | — | `range: $cost · N requests` (or just N requests) | `Spend (range)` or `Requests (range)` |

## Build, test, package

```bash
npm install
npm run compile          # tsc -p ./
npm test                 # compile + node --test out/api.test.js
npx @vscode/vsce package # produces ollama-cloud-usage-<version>.vsix
```

`.vscodeignore` keeps `src/`, maps, tests, node_modules, and dev-only files out of the VSIX.

## Change history (important)

### 1.1.1 — 2026-10-20

- Fixed proxy bypass: `src/api.ts` imported `node:https`, which skips VS Code's extension-host `https` patch. Switched to `https`; requests now use the system/configured proxy (`http.proxySupport`, default `override`).

### 1.1.0 — 2026-10-20

Ollama changed the API on **2026-10-07**; the extension had been broken.

- Quota moved from `/api/usage` (`activity` + `limits`) to `/api/balance`.
- `/api/usage` became a time series (`totals` + `buckets`), still supports `group_by=model`.
- Auth changed to `Authorization: Bearer <key>`.
- Reset times are server-provided; removed the UTC boundary heuristic.
- Added credit-plan support (USD balance/allowance/period, 30d model breakdown).
- Fixed the error tooltip pointing at the non-existent `ollamaCloud.setApiKey` command.
- Verified against real legacy responses (balance + 24h + 7d) on 2026-10-20: session window 06:00Z–11:00Z summed to 780 requests and weekly window from Monday 00:00Z summed to 1,550 requests, both matching bucket sums.

## Gotchas

- **Import `https`, never `node:https`.** VS Code monkey-patches `require('https')` in the extension host to honour `http.proxy` / system proxy settings (`http.proxySupport`, default `override`). The `node:https` specifier bypasses that patch, causing `ETIMEDOUT` on networks where `ollama.com` is only reachable through a proxy. This was the cause of the 1.1.1 fix.
- Do not assume `usage_usd` exists; it did not in the real legacy payload.
- Do not assume `groups` exists on every bucket (empty arrays occur).
- `totals.groups` is capped at 10 models plus an optional `remainder`; per-bucket groups are used for window counts.
- Credit-plan behavior is implemented from the official docs and simulated fixtures; it has **not** been tested against a real credit account yet. If one is available, capture `/api/balance` and `/api/usage?range=30d&group_by=model` and add fixtures.
- No custom proxy agent is needed: relying on VS Code's module patch keeps credentials and PAC handling working. If an explicit proxy is ever required (e.g. proxy support disabled), resolve it from `http.proxy` / `HTTPS_PROXY` and add CONNECT support deliberately.

<!-- KB-POINTER:START — managed by agent-knowledge-base /kb-onboard. Do not edit by hand. -->
## 🧭 Multi-repo workspace — Knowledge Base

This repository is part of a **multi-repo workspace**. A shared knowledge base
describes every repo here and how they connect.

- **KB location:** `../.knowledge-base/`
- **This repo in the KB:** `../.knowledge-base/repos/ollama-cloud-usage/overview.md`

**Before any cross-cutting work** (new feature, refactor, anything that might
touch more than this repo), read in order and stop when you have enough:

1. `../.knowledge-base/INDEX.md` — what every repo is.
2. `../.knowledge-base/relationships.md` — how they connect + impact table.
3. `../.knowledge-base/repos/ollama-cloud-usage/overview.md` — this repo's map.

For a feature that may span repos, run `/kb-feature "<description>"` **from the
KB** (the `feature-workflow` skill at
`../.claude/skills/feature-workflow/SKILL.md`): it finds affected repos via the
KB, drafts a plan + self-contained task specs, writes testcases before
implementation, and can execute the plan with tiered executor/verifier
subagents. Plans live in `../.knowledge-base/plans/`.

`/kb-*` commands don't exist in a session opened directly in this repo — open
one in the KB (or run `/kb-install-root` once from the KB to also get them at
the workspace root). From here, just read the KB files by path as above.

If you changed code here, keep the KB current with `/kb-update`.
<!-- KB-POINTER:END -->
