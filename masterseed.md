# 🌱 MASTERSEED — Thai Trading Simulator (TTS)
> Resume any new chat or CC session from this file. Always read `lessons_learned.md` too.
> **Last Updated:** 2026-05-23 — Phase 8b complete. D1 tab shows live results from Worker. No broken state.

---

## PROJECT IDENTITY

- **Name:** Thai Trading Simulator (TTS)
- **Purpose:** Paper trading learning ground → signature tactic library → eventual live broker connection
- **Owner:** Single user, no auth required
- **Ultimate Goal:** Fully automated personal trading desk — consistent small green-candle harvesting toward ฿500/day target
- **Philosophy:** Learn basics (MA, RSI) → build confidence → hybrid AI + preset "signature tactics" → connect real broker when ready

---

## OPERATING MODEL (CC ERA — as of 2026-05-23)

**Old model (retired):** Chat generates patches → owner manually edits files → sends back → error → repeat. Caused cascading errors. Retired permanently.

**New model:**
1. **Consult** — Owner describes goal/direction to Claude Chat
2. **Prompt** — Chat prepares a precise, full-context CC prompt
3. **Execute** — CC reads repo directly, writes complete replacement files, commits
4. **QA** — Chat reviews CC output and checks for regressions
5. **Log** — CC writes its own change notices and lesson updates to repo files

**CC Golden Rules:**
- Always `read` the file from repo before writing — never assume it matches a previous version (L033, L075)
- Always write complete replacement files — never patches (L074)
- Any edit to if/else chains: show the ENTIRE chain in one block (L076)
- Commit with a descriptive message referencing the phase/fix
- After writing, update `masterseed.md` and `lessons_learned.md` in the same commit

---

## STACK (LOCKED)

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Recharts | Cloudflare Pages, auto-deploys from GitHub main |
| Workers | Cloudflare Workers | Single `index.js`, all routes |
| Live State | Cloudflare KV | Portfolio state, intel cache (24hr) — binding: `TTS_KV` |
| History | Cloudflare D1 | Trade log, P&L — `tts-db` database — binding: `TTS_DB` |
| AI | Anthropic `claude-sonnet-4-20250514` | Via Worker only, NEVER from browser |
| SET Data | Yahoo Finance proxy (15-min delay) | Worker-proxied (L002) |
| Gold Data | Yahoo Finance GC=F futures | Worker-proxied |

---

## DEPLOYMENT (CRITICAL)

| Where | How | URL |
|---|---|---|
| Worker | Paste `index.js` manually in Cloudflare editor → Save & Deploy | `https://tts-workers.csmittee.workers.dev` |
| Frontend | Push to GitHub main → Cloudflare Pages auto-deploys | `https://trade-simulation-5ce.pages.dev` |
| GitHub repo | `https://github.com/Csmittee/Trade-simulation` | CC clones and commits here |
| **NEVER** | Connect GitHub to the Worker (L010) | — |
| **File push order** | New files first, importing files last (L017) | — |
| **CSS location** | `src/dashboard.css` ONLY — imported by `src/main.jsx` | — |

---

## BUILD PHASES

| Phase | Scope | Status |
|---|---|---|
| 0 | Blueprint + docs | ✅ COMPLETE |
| 1 | Gold tab + live data + manual trading + KV state + chart | ✅ COMPLETE |
| 2 | SET tab + Yahoo Finance Worker + timeframes + chart fixes | ✅ COMPLETE |
| 3 | Preset strategy engine + auto-execution + D1 logging | ✅ COMPLETE |
| 4 | Layout + Activity Log + AI Assist + sell desk + bug fixes | ✅ COMPLETE |
| 5 | Session persistence + Activity D1 log + KV optimization | ✅ COMPLETE |
| 6 | Bottom panel redesign + 6-fix sprint + workflow split (14 states) + Battlefield Gantt | ✅ COMPLETE |
| 6b | AI workflow split (14 states) + per-symbol SET workflow dict (KI011 fix) | ✅ COMPLETE |
| 6d | Per-symbol SET preset strategy + Portfolio black screen fix | ✅ COMPLETE |
| 7a | Grouped positions table in SET tab (Active view) | ✅ COMPLETE |
| 7b | Per-lane own scale ruler + curated KV watchlist | ✅ COMPLETE |
| 8  | D1 Query Builder tab — click-to-generate SQL | ✅ COMPLETE |
| 8b | D1 tab live results — real fetch from Worker, SQL generator for destructive ops | ✅ COMPLETE |
| 7 | Portfolio Battlefield — AI advisor sync to Gold/SET + executable plan | ⬜ NOT STARTED |
| 9 | SET selection UX overhaul (watchlist, buy list, better graph, search) | ⬜ BACKLOG |
| 9 | D1 Tab — deep log viewer + manual adjustment interface | ⬜ BACKLOG |
| 10 | Bitcoin/Crypto tab | ⬜ BACKLOG |
| 11 | Long-term dividend portfolio summary | ⬜ BACKLOG |
| 12 | Live broker API connection | ⬜ BACKLOG |

---

## CURRENT BROKEN STATE

✅ No broken state as of Phase 8b (2026-05-23).

---

## CONFIRMED WORKING FEATURES (DO NOT BREAK)

| Feature | Status |
|---|---|
| KI011 — per-symbol SET AI workflow | ✅ Working |
| Watchlist hide/collapse | ✅ Working |
| SET tier filter (Top 50/100/All) with dedup | ✅ Working |
| set-injector includes activeSymbol in batch fetch | ✅ Working |
| Gold market — all features | ✅ Working |
| Activity log D1 | ✅ Working |
| index.js Worker — all routes | ✅ Working (no changes needed) |
| OrderPanel.jsx | ✅ Working (no changes needed) |
| StrategyPanel.jsx | ✅ Working (no changes needed) |
| dashboard.css — watchlist collapse styles | ✅ Working |
| Portfolio Battlefield Zone 1/2/3 | ✅ Working |
| Portfolio own-scale Gantt — per-lane independent ruler | ✅ Working (Phase 7b) |
| SET curated watchlist (My Watchlist pinned section) | ✅ Working (Phase 7b) |

---

## CURRENT FILE INVENTORY

### Worker (paste manually in Cloudflare editor — never connect GitHub)
```
index.js    routes: /api/gold, /api/history, /api/set,
                    /api/portfolio, /api/settings,
                    /api/trades    (D1 — GET: market, symbol, side, from, hours, open, executor, trash, limit)
                    /api/trades/summary  (D1 — GET: group=day|week|month)
                    /api/trades/count    (D1 — GET: total, buys, sells, open_buys)
                    /api/intel (AI insider intel)
                    /api/strategy (AI workflow)
                    /api/logs (D1 activity log — GET + POST)
                    /api/debug
```

### Frontend — exact folder structure
```
/                          ← repo root
├── config.js              ✅ All endpoints, strategy presets, AI model name
├── index.html             ✅ Vite entry point
├── vite_config.js         ✅ Vite config
├── package.json
└── src/
    ├── main.jsx           ✅ React entry — imports "./dashboard.css"
    ├── dashboard.css      ✅ Phase 6 — bottom panel 38vh, 10-col table,
    │                         sell desk pinned, watchlist collapse styles
    ├── components/
    │   ├── ChartPanel.jsx      ✅ SVG overlay candlesticks, timeframe-aware, gap-handling
    │   ├── OrderPanel.jsx      ✅ Manual (collapsible) + AI Assist tabs
    │   ├── StrategyPanel.jsx   ✅ autoExecute PROP, duration selector
    │   ├── ActivityLog.jsx     ✅ Hourly collapse groups, makeActivityEvent helper
    │   └── Tooltip.jsx         ✅ Bubble help system
    ├── core/
    │   └── portfolio-engine.js ✅ executeBuy, executeSell, executeSellQty (FIFO),
    │                              suggestPositionSize (capped), getRiskDefaults
    ├── injectors/
    │   ├── gold-injector.js    ✅ Gold data + history + SL/TP auto-close
    │   ├── set-injector.js     ✅ SET watchlist + history + SL/TP auto-close
    │   ├── strategy-injector.js ✅ All 5 strategy signal engines
    │   ├── intel-injector.js   ✅ Hover intel for symbols
    │   └── portfolio-injector.js ✅ Phase 7b — computePerLaneScale, computeSharedOwnRuler, computeUniqueLanes
    └── pages/
        ├── Dashboard.jsx       ✅ Phase 8 — D1Tab import, 4th tab entry, D1Tab render
        ├── D1Tab.jsx           ✅ Phase 8b — 8 live READ queries + 1 SQL-only reset; "Under the hood" panel shows API URL + SQL
        ├── GoldMarket.jsx      ✅ Working
        ├── SetMarket.jsx       ✅ Phase 7b — curated watchlist panel, watchlistCollapsed=true, new props
        └── Portfolio.jsx       ✅ Phase 7b — per-lane own scale (visibleLanesOwn, bf2-per-lane-ruler)
```

---

## ROADMAP (after Phase 6d fix)

| Priority | Phase | Feature | Notes |
|---|---|---|---|
| 1 | 7 | Portfolio AI generates executable plan synced to Gold/SET tabs | |
| 2 | 7c | Click position row → auto-switch symbol + fill buy price | activeSymbol set + OrderPanel price pre-filled |
| 3 | 9 | SET selection UX overhaul | Better live graph, enhanced watchlist |
| 4 | 8b | D1 Tab — live log viewer (read from Worker) | ✅ DONE Phase 8b |
| 5 | 10 | Bitcoin/Crypto tab | Follow platform strategy |
| 6 | 11 | Long-term dividend portfolio summary | Stocks held for dividend, annual financial view |
| 7 | 12 | Live broker API connection | Real buy/sell — validation gate required before this phase |

---

## CRITICAL RULES — ALWAYS

- **Worker URL:** `https://tts-workers.csmittee.workers.dev`
- **AI model:** always `claude-sonnet-4-20250514`
- **KV binding:** `TTS_KV` | **D1 binding:** `TTS_DB` | **KV bundle key:** `settings:strategyBundle`
- **CSS file:** `src/dashboard.css` — single file, never duplicate
- **No local dev** — GitHub → Pages or manual Worker paste only
- **executeSellQty** for all user-facing sells — NEVER call `executeSell` directly
- **Duration = MINUTES (integer)** — `parseDurationMs(n) = n * 60 * 1000` (L073)
- **All Session** fetches from D1 `?hours=12` — NEVER reads `portfolio.closedTrades` memory
- **Sell desk** always rendered outside scroll zone — never conditionally hidden
- **aiWorkflowActive** computed in Dashboard: `!!workflow && !workflowDone`
- **Manual Order panel** always starts collapsed on load/tab-switch
- **Three-point prop chain** (L054): any new prop must be added in Dashboard, SetMarket destructure, AND OrderPanel/StrategyPanel simultaneously
- **File push order** (L017): new files before importing files
- **Read before write** (L033, L075): CC must always read fresh file from repo before replacing

---

## ENVIRONMENT VARIABLES (Worker only)

```
ANTHROPIC_API_KEY=   ← Worker env, never in frontend
TTS_KV=              ← KV namespace binding
TTS_DB=              ← D1 database binding
```

---

## OWNER CONTEXT

- Building vending machine business + Thailand online auction app simultaneously
- Trading sim goal: ฿500/day cashflow — steady, not get-rich
- Strategy: green candle scalping → accumulate small profits → daily target
- Focus is SELL decisions — "when to exit" is the edge
- End vision: tool trains owner → owner builds signature tactics → tool connects broker → runs autonomously
