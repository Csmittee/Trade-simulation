# 📚 LESSONS LEARNED — Thai Trading Simulator
> Updated at the end of each phase. CC must read this before starting any session.
> From 2026-05-23 onward, CC is the primary coder. Chat is project management only.

---

## HOW TO USE THIS FILE
- CC: read this at the start of every task. Follow all rules tagged with your current phase.
- Chat: use this when preparing CC prompts to include the most relevant lesson IDs.

---

## PHASE 0 — Architecture & Planning

### L001 — Thai Gold Has No Official API
**Problem:** No public API exists for Thai gold price from AAAGOLD or YLG.
**Solution:** Cloudflare Worker scrapes Yahoo Finance GC=F futures. Convert USD→THB using live rate.
**Formula:** Thai gold (96.5% purity) = `XAUUSD × (THB/USD rate) × 0.965 × (weight in baht / troy oz conversion)`
**1 baht weight = 15.244 grams; 1 troy oz = 31.1035 grams**
**Tag:** #data #gold #phase0

### L002 — Yahoo Finance for SET Data Has CORS Issues in Browser
**Problem:** Calling Yahoo Finance directly from React will get blocked by CORS.
**Solution:** Always route through Cloudflare Worker (`/api/set`). Worker fetches, returns clean JSON.
**Never** call Yahoo Finance or any financial API directly from the React frontend.
**Tag:** #cors #set #data #phase0

### L003 — Cloudflare KV Is Eventually Consistent
**Problem:** KV writes are not instantly visible on read in the same Worker invocation.
**Solution:** For portfolio state that must be immediately consistent, use D1 as source of truth and KV as read cache.
**Tag:** #kv #d1 #consistency #phase0

### L004 — Anthropic API Must Never Be Called From Frontend
**Problem:** Calling Anthropic API from React would expose the API key in browser network tab.
**Solution:** All Anthropic calls go through Worker. Frontend calls Worker URL only.
**Tag:** #security #anthropic #phase0

### L005 — Token Optimization for Insider Intel
**Strategy:** Hover 1.5s before triggering. KV cache-first (key = `intel:{symbol}:{date}`).
**Cap:** `max_tokens: 150`. JSON response: `{factors:[], sentiment:"bullish|bearish|neutral", confidence:"low|medium|high"}`
**Tag:** #tokens #optimization #intel #phase0

### L006 — Injector Pattern (One JS File Per Market)
**Decision:** Each market tab has its own injector file to isolate concerns.
**Rule:** Never put market-specific logic in shared core. Cross-market logic only in `portfolio-engine.js`.
**Tag:** #architecture #injectors #phase0

### L007 — Market Hours Toggle Implementation
**Decision:** Toggle stored in KV key `settings:market_hours_enforce` as string "true"/"false".
**SET hours ICT:** Session 1: 10:00–12:30, Session 2: 14:30–17:00 (Mon–Fri)
**Gold hours:** 24×5 (closed weekends)
**Tag:** #market-hours #sim-engine #kv #phase0

### L008 — Balance Reset Behavior
**Wipes:** KV portfolio state → fresh. D1 trade history → KEPT intentionally.
**Tag:** #balance #reset #phase0

---

## PHASE 1 — Gold Market + KV + Basic Chart

### L009 — metals.live Returns Array Not Object
**Solution:** `Array.isArray(data) ? data[0]?.price : data?.price`
**Tag:** #gold #api #phase1

### L010 — Cloudflare Worker and Pages Are Completely Separate Products
**Worker** = API backend (paste code manually in editor, never connect GitHub here).
**Pages** = frontend (connect GitHub here, auto-deploys on push).
**Tag:** #cloudflare #pages #worker #phase1

### L011 — Single Worker Handles All API Routes
All routes live in one Worker file `index.js`. One deploy updates everything.
**Tag:** #worker #architecture #phase1

### L012 — KV Binding Must Be Named TTS_KV
Cloudflare → tts-workers → Settings → Variables → KV Namespace Bindings → Variable name: `TTS_KV`
**Tag:** #kv #setup #phase1

### L013 — Pages Deploy Command Must Be Empty
Cloudflare Pages auto-fills `npx wrangler deploy` which fails. Leave deploy command empty.
**Tag:** #pages #deploy #phase1

### L014 — portfolio.balance Defaults to 0 From KV
**Solution:** Dashboard checks `balance > 0 || startingBalance > 0` before accepting KV state.
**Tag:** #kv #portfolio #phase1

### L015 — Recharts Customized Component Not Usable in v2.12
**Solution:** Use absolute-positioned SVG overlay with ResizeObserver + manual price-to-pixel math.
**Tag:** #chart #recharts #candlestick #phase1

### L016 — calcPortfolioSummary Crashes on Missing Arrays
**Solution:** All engine functions have `Array.isArray()` guards at entry.
**Tag:** #portfolio-engine #kv #phase1

---

## PHASE 2 — SET Market + Workers + Chart Timeframes

### L017 — GitHub Upload Order Matters for Dependent Files
**Solution:** Always push new files FIRST, then files that import them LAST.
**Order for Phase 2:** SetMarket.jsx → set-injector.js → Dashboard.jsx
**Tag:** #deployment #github #cloudflare #phase2

### L018 — Timeframe State Must Live in Market Page, Not ChartPanel
**Solution:** Timeframe state lives in GoldMarket/SetMarket. Passed to injector (re-fetches) AND ChartPanel.
**Tag:** #chart #timeframe #architecture #phase2

### L019 — Yahoo Finance 1h Interval Unreliable for SET Stocks
**Solution:** For SET 1M, always use `interval=1d`. Gold 1M can use `1h`.
**Tag:** #set #yahoo #interval #phase2

### L020 — Gap Markers for Day Boundaries
**Solution:** Worker inserts `{isGap:true}` candle at each day boundary. ChartPanel skips gap candles.
**Tag:** #chart #gaps #phase2

### L021 — MA Calculation Must Skip Gap Candles
**Solution:** MA function collects only non-gap, non-null closes. Combined with `connectNulls={false}`.
**Tag:** #chart #ma #gaps #phase2

### L022 — MA5/MA20 Invisible on 1M Daily View — Expected
With 22 daily candles, MA20 barely renders. Correct behavior.
**Tag:** #chart #ma #phase2

### L023 — X-Axis Label Format by Timeframe
- `range=1d` → `"HH:MM"`, `range=5d` → `"ddd DD HH:MM"`, `range=1mo` → `"MMM DD"`
**Tag:** #chart #labels #phase2

### L024 — handleSet Missing From Worker Caused Error 1101
**Solution:** Always verify function existence before presenting output files. Never use Python sed for multi-line insertions.
**Tag:** #worker #deployment #phase2

### L025 — Historical THB Conversion Uses Current Rate
THB/USD rate cached daily in KV. Historical bars use current rate (acceptable approximation).
**Tag:** #gold #currency #phase2

---

## PHASE 3 — Preset Strategy Engine

### L026 — Strategy Signal Must Debounce on Flat Candles
Prevent multiple signals on identical closes. Check `close !== prevClose` before firing.
**Tag:** #strategy #signals #phase3

### L027 — Strategy Engine Is Stateless Per Candle
Signal engine re-evaluates on every price tick. State (position) is in portfolio, not strategy.
**Tag:** #strategy #architecture #phase3

### L028 — Confirm Card Must Block Duplicate Orders
One pending confirm card per symbol. Reject if card already shown for this symbol.
**Tag:** #strategy #ux #phase3

### L029 — All 5 Strategy Engines in strategy-injector.js
MA Crossover, RSI Oversold, Bollinger Bands, VWAP Reversion, Momentum Breakout — all in one file.
**Tag:** #strategy #architecture #phase3

### L030 — autoExecute Is Dashboard State, Passed as Prop
Never manage autoExecute inside StrategyPanel or injector. It lives in Dashboard.
**Tag:** #strategy #state #phase3

---

## PHASE 4 — Layout + AI Assist + Activity Log

### L031 — OrderPanel Always Starts Collapsed
`manualCollapsed` always initializes to `true`. Reset to `true` on tab switch.
**Tag:** #orderpanel #ux #phase4

### L032 — Risk Level Click Auto-Fills SL, TP, Qty
Clicking low/medium/high risk → auto-populates all three fields using getRiskDefaults().
**Tag:** #orderpanel #ux #phase4

### L033 — Project Panel Files Can Be Stale — Always Read Fresh From Repo
**Problem:** Files shown in the project panel during a chat session may be an old snapshot. Edits made in a previous session are not reflected.
**Rule:** At the start of every session, upload the latest file from GitHub. In CC era: CC must always read from the repo via `git` or file read before writing any replacement.
**Tag:** #workflow #files #phase4 #cc

### L034 — AI Intel Prompt Must Be Under 500 Tokens
Keep symbol + context + instruction tight. Response capped at 150 tokens.
**Tag:** #ai #tokens #phase4

### L035 — ActivityLog Uses makeActivityEvent Helper
All activity entries are created through `makeActivityEvent(type, data)` — never construct objects manually.
**Tag:** #activitylog #phase4

---

## PHASE 5 — Session Persistence + KV Optimization

### L036 — KV Portfolio Bundle Key: settings:strategyBundle
All 9 strategy fields (activeStrategy, autoExecute, strategyDuration, orderMode, riskLevel, qty, price, sl, tp) stored as ONE JSON blob. One KV write on change. Never write individual keys.
**Tag:** #kv #strategy #phase5

### L037 — KV Usage Alert at 50% — Bundle Everything
Monitor KV usage. Any new persistent setting must join the existing bundle, never get a new key.
**Tag:** #kv #optimization #phase5

### L038 — D1 Trade Insert Must Include Symbol Field
`INSERT INTO trades (symbol, side, qty, entry_price, exit_price, pnl, closed_at)` — symbol is mandatory for D1 queries by market.
**Tag:** #d1 #trades #phase5

### L039 — D1 Activity Log: INSERT on Every Meaningful Event
Use `/api/logs` POST with `{ event_type, symbol, message, metadata }`. Worker does the insert.
**Tag:** #d1 #activitylog #phase5

### L040 — suggestPositionSize Capped at min(affordable, 50% of balance)
Never allow the engine to suggest a position that risks more than 50% of current balance.
**Tag:** #portfolio-engine #risk #phase5

---

## PHASE 6 — Bottom Panel Redesign + 6-Fix Sprint

### L061 — Open/Closed Tab Pattern Causes Chart Compression
**Fix:** Removed tab row entirely. Single toggle button in panel3-header row. Zero extra height cost.
**Tag:** #css #layout #panel-bottom #phase6

### L062 — Sell Desk Must Live Outside the Scroll Zone
**Rule:** Sell desk is always a `flex-shrink: 0` element AFTER the `positions-zone` div. Never inside any scrollable container. Applies to both GoldMarket and SetMarket.
**Tag:** #sell-desk #layout #phase6

### L063 — panel-bottom Needs Both min-height and max-height
**Fix:** `min-height: 38vh` + `max-height: 38vh` — panel always opens to exactly 38vh. Scroll activates inside when content overflows.
**Tag:** #css #panel-bottom #layout #phase6

### L064 — In-Memory closedTrades Lost on Refresh — Use D1 for All Session
**Rule:** "All Session" always fetches from D1 with `?hours=12&side=sell`. Never rely on `portfolio.closedTrades` React state for history views.
**Tag:** #d1 #state #refresh #phase6

### L065 — D1 Closed Trade Fields Are snake_case, Not camelCase
D1 uses `entry_price`, `exit_price`, `closed_at`. In-memory uses `entryPrice`, `exitPrice`, `closedAt`. Always check the source before accessing fields.
**Tag:** #d1 #data-shape #phase6

### L066 — Unified Table: One Grid, Two Row Types
Single `positions-table--10col`. Each row has `_rowType: "open"` or `"closed"`. Header sticky. Closed rows use `.pos-row--closed` (opacity 0.75).
**Tag:** #table #layout #phase6

### L067 — Invalidate Session Cache After Every Sell
After any sell (manual or strategy), set `setSessionLoaded(false)` so next "All Session" click re-fetches D1 fresh.
**Tag:** #d1 #cache #sell #phase6

### L068 — AI Workflow State Is Shared Between Gold and SET — FIXED
**Fix (Phase 6b):** Dashboard now holds 14 separate states: `goldWorkflow`, `setWorkflow`, `goldStageStatuses`, `setStageStatuses`, `goldActiveStageIdx`, `setActiveStageIdx`, `goldWorkflowDone`, `setWorkflowDone`, `goldFallbackTriggered`, `setFallbackTriggered`, `goldStagePnl`, `setStagePnl`, `goldConsecutiveRed`, `setConsecutiveRed`.
**Tag:** #workflow #ai #dashboard #phase6b

### L069 — SET AI Workflow Locks All Symbols — FIXED via KI011
**Fix (Phase 6b/6c):** `setWorkflows` is a per-symbol dictionary `{ "PTT.BK": {...}, "SCB.BK": {...} }`. Dashboard passes full dictionary to SetMarket. SetMarket derives the active symbol's slice. `computeUniqueLanes` looks up `setWorkflows[lane.symbol]` per SET lane.
**Tag:** #workflow #set #symbol #phase6b

### L070 — Portfolio Battlefield: Own Scale Uses Gantt Model
**Pattern:** Bar = full planned span (open date → last stage end). Now-dot moves L→R. Not a progress fill.
`computeSharedOwnRuler()` finds earliest open + latest end across all lanes, generates 5 ticks, computes per-lane `ownScaleBarStart`, `ownScaleBarEnd`, `ownScaleNowPct`.
**Tag:** #portfolio #battlefield #gantt #phase6

### L071 — Portfolio Battlefield: Stage Milestone Nodes
Each AI workflow stage gets a `stageNode` object `{id, label, action, timeWindow, endMs, status, isActive, pct}`. Positioned at `pct%` on the Gantt bar. Hover shows tooltip.
Node colors: pending=gray, active=gold+pulse, win=green, loss=red, skipped=muted.
**Tag:** #portfolio #battlefield #stages #phase6

### L072 — Portfolio AI Advisor Returns Workflow JSON — Parser Fix
Prompt says "plain text NO JSON, 3 sentences only". Parser extracts `reasoning` + active stage action as fallback. Never falls through to `JSON.stringify()`.
**Tag:** #ai #portfolio #advisor #phase6

### L073 — Duration Stored as MINUTES (Integer), Not String Keys
`parseDurationMs(duration)` = `parseFloat(duration) * 60 * 1000`. Works for any number. Never use string keys like `"3d"` or `"4h"`.
**Tag:** #duration #strategy #phase6

---

## PHASE 6d — CC Transition (NEW)

### L074 — Never Send Patches for Multi-Location Changes
**Problem:** When the same logical change touches 4+ files and 10+ locations, patch instructions cause misapplication, orphaned code blocks, and cascading build errors that are nearly impossible to trace.
**Rule:** For any change touching 3+ files or 5+ locations in one file, CC must write complete replacement files. Never patch.
**Tag:** #workflow #cc #phase6d

### L075 — Verify File Before Writing, Always
**Problem:** CC-generated files based on project panel copies may be stale. Owner had to upload fresh files repeatedly.
**Rule:** CC must always `read` the file from the repo before writing a replacement. Never assume the file matches what was seen in a previous chat session.
**Tag:** #workflow #cc #phase6d

### L076 — JS Conditional Chain Must Be Atomically Replaced
**Problem:** Replacing an `else if / else` chain across multiple messages caused a middle branch to be orphaned — the opening line of one `useCallback` was dropped, leaving a floating function body that caused a minified variable initialization error at runtime.
**Rule:** Any edit to a conditional chain (if/else if/else) must show the ENTIRE chain in one block. Never split across messages or steps.
**Tag:** #javascript #patching #phase6d

### L077 — CC Must Update masterseed.md and lessons_learned.md After Every Fix
**Rule:** After completing any fix commit, CC must append a change summary to `masterseed.md` (update broken state, phase status, file inventory) and append any new lessons to `lessons_learned.md`. This keeps the repo self-documenting and the next chat/CC session always starts with accurate context.
**Tag:** #workflow #cc #documentation #phase6d

---

## PHASE 7a — Grouped Positions Table

### L078 — Active vs All Session Views Need Separate Rendering Paths
**Pattern:** When a view toggle switches between two fundamentally different display modes (grouped vs flat), use a single IIFE with an early-return branch per mode rather than conditional JSX at the component level. Keeps the scroll container consistent and avoids key-collision between the two render trees.
**Rule:** `if (posView === "all") { return flatTable; } return groupedTable;` inside the positions-zone IIFE.
**Tag:** #positions #ux #phase7a

### L079 — Expand Button Must stopPropagation to Avoid Triggering Parent onClick
**Problem:** A `▶/▼` expand button inside a clickable row will fire both the button's onClick and the row's onClick (symbol switch) if stopPropagation is missing.
**Rule:** Always call `e.stopPropagation()` in the expand button handler when the parent div has its own onClick.
**Tag:** #ux #events #phase7a

---

## KNOWN ISSUES LOG

| ID | Issue | Status | Phase Found |
|---|---|---|---|
| KI001 | XAUUSD tab Y-axis doesn't update (stays THB) | Accepted — user trades THB only | Phase 1 |
| KI002 | MA5/MA20 nearly invisible on 1M daily | Accepted — correct behavior | Phase 2 |
| KI003 | SET 1W shows session times not dates on X-axis | Partially fixed | Phase 2 |
| KI007 | Cloudflare KV at 50% usage | Mitigated — monitor | Phase 5 |
| KI008 | Gold/SET share same AI workflow state | ✅ Fixed Phase 6b | Phase 6 |
| KI009 | Portfolio Battlefield tab | ✅ Fixed Phase 6 — Gantt lanes, milestone nodes, AI advisor | Phase 6 |
| KI010 | dashboard.css has dead CSS rules | Deferred — safe to ignore | Phase 6 |
| KI011 | SET AI locks all symbols when one has workflow | ✅ Fixed Phase 6b/6c — per-symbol dict | Phase 6b |
| KI012 | Portfolio tab black screen after Phase 6d manual patch | 🔴 Active — CC Phase 6d fix | Phase 6d |

---

## USEFUL REFERENCES

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare KV: https://developers.cloudflare.com/kv/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Anthropic API: https://docs.anthropic.com/
- Yahoo Finance chart API: `query2.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=5m&range=1d`
- SET symbol format: append `.BK` (e.g. `PTT.BK`, `AOT.BK`)
- Worker URL: `https://tts-workers.csmittee.workers.dev`
- Pages URL: `https://trade-simulation-5ce.pages.dev`
- GitHub repo: `https://github.com/Csmittee/Trade-simulation`

---

## CONVENTIONS ESTABLISHED

| Convention | Rule |
|---|---|
| KV key format | `category:subcategory` e.g. `portfolio:balance` |
| KV bundle key | `settings:strategyBundle` — all strategy fields in one JSON blob |
| D1 table names | lowercase_underscore |
| D1 field names | snake_case (`entry_price`, `closed_at`) — not camelCase |
| Component props | Always destructured, never `props.x` |
| Worker routes | `/api/gold`, `/api/set`, `/api/history`, `/api/intel`, `/api/strategy`, `/api/trades`, `/api/logs` |
| Error handling | Every Worker returns `{success: bool, data: any, error: string\|null}` |
| Timeframe state | Lives in market page (GoldMarket/SetMarket), not in ChartPanel |
| File push order | New files first, importing files last |
| Strategy name | Always use `PRESETS.find(p => p.id === activeStrategy)?.name` |
| Sell flow | Always `executeSellQty` for user sells — never `executeSell` directly |
| Activity events | Always `makeActivityEvent` or rely on Dashboard normalisation |
| Manual collapse | `manualCollapsed` always starts `true` in OrderPanel |
| All Session data | Always D1 `?hours=12` — never `portfolio.closedTrades` memory |
| Sell desk | Always outside scroll zone, always rendered, never conditional on toggle |
| Duration | Always stored as MINUTES (integer) — `parseDurationMs(n) = n * 60 * 1000` |
| AI model | Always `claude-sonnet-4-20250514` — never change this |
| CC file writes | Always read from repo first, then write complete replacement — never patch |
| CC self-logging | CC must update masterseed.md + lessons_learned.md after every fix commit (L077) |
