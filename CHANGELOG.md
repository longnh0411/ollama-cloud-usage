# Changelog

All notable changes to the Ollama Cloud Usage extension.

## 1.1.1 - 2026-10-20

### Fixed
- Requests now use the bare `https` module. VS Code patches `require('https')` in the extension host to route through the configured/system proxy; importing `node:https` bypassed that patch and caused timeouts on networks where `ollama.com` is only reachable through a proxy.

## 1.1.0 - 2026-10-20

### Fixed
- Adapted to Ollama's 2026-10-07 API change. Quota data now comes from `GET /api/balance` (the `/api/usage` response no longer contains `activity` / `limits`; it returns a time series with `totals` and `buckets`).
- Requests now send `Authorization: Bearer <API key>`, matching the current API docs.
- Reset countdowns use the server-provided `resets_at` / `period.until` timestamps instead of the local UTC boundary heuristic (removed `resetTime.ts`).
- Error tooltips now open the Add Account command instead of the non-existent `setApiKey` command.

### Added
- Support for credit-based plans alongside legacy 5h/weekly plans: the status bar and panel show the USD credit balance and allowance, and model breakdowns use `range=30d` to cover the included period.
- Model breakdowns from `GET /api/usage?range=24h|7d&group_by=model`, including session-window counts derived from hourly buckets.
- 7-day request summary (USD spend shown when the plan reports `usage_usd`).

## 1.0.5 - 2026-08-19

### Changed
- Reset windows now UTC-anchored: session on 5h boundaries (00/05/10/15/20 UTC), weekly on Monday 00:00 UTC. Replaces the previous 11:00-local heuristic.
- Status bar: single item, click opens detail panel. Removed double-click and separate refresh button.
- Auto-refresh interval reduced from 5 minutes to 60 seconds.
- Usage panel bars split into per-model segments, each a distinct blue shade (by index). Removed the green/yellow/red severity coloring.
- Model list follows API order; per-model request count shown (hover bar segment for model name + count).
- Tooltip shows quota table with per-model share bars and reset countdowns.

### Fixed
- Reset time no longer depends on local timezone / DST.

## 1.0.3 - 2026-08-04

### Fixed
- Session 5h reset time: now anchored to 11:00 today with a rolling 5h window (matches Ollama's actual reset behavior) instead of fixed hourly slots.

## 1.0.2 - 2026-08-04

### Fixed
- README screenshots now use absolute GitHub raw URLs so images render on the marketplace and web.

## 1.0.1 - 2026-08-04

### Added
- Screenshots of the usage panel and status bar to the README.

## 1.0.0 - 2026-08-04

### Added
- Multi-account support: switch, add, remove accounts via a dropdown in the panel.
- Reset countdown displayed under each usage bar (session and weekly).
- Status bar indicator with color-coded severity (green/yellow/red).
- Auto-refresh every 5 minutes.
- Secure API key storage in VS Code Secret Storage.

## 0.0.1 - Initial version

### Added
- View Ollama Cloud usage and limits.
