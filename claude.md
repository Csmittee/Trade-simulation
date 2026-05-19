# CLAUDE.md — Thai Trading Simulator (TTS)

**Last Updated:** Phase 6 — Bottom panel redesign complete

You are working on a **Cloudflare Pages + Workers** paper trading simulator for Thai Gold and SET market.

## PROJECT OVERVIEW
- Full-stack paper trading simulator (Gold + SET)
- Goal: Build confidence → signature tactics → eventual live broker connection
- Focus: Clean architecture, reliability, and good UX

## TECH STACK (LOCKED)
- **Frontend**: React 18 + Vite + Recharts (Cloudflare Pages)
- **Backend**: Single Cloudflare Worker (`index.js`)
- **State**: Cloudflare KV (`TTS_KV`)
- **History**: Cloudflare D1 (`TTS_DB`)
- **AI**: Claude Sonnet via Worker only
- **Data**: Yahoo Finance (proxied through Worker)

## CRITICAL RULES

### Deployment Rules
- **Worker**: NEVER connect GitHub. Always manually paste `index.js` in Cloudflare dashboard.
- **Frontend**: Push to GitHub → Cloudflare Pages auto deploys.
- Push order: New files first → files that import them last.
- Always upload fresh GitHub file before asking Claude to modify it.

### Architecture Rules
- One Worker handles all API routes (`/api/*`)
- KV binding name must be `TTS_KV`
- D1 binding name must be `TTS_DB`
- All Anthropic calls go through Worker (never frontend)
- Market-specific logic stays in injectors (`gold-injector.js`, `set-injector.js`)
- Core shared logic stays in `portfolio-engine.js`

### State Management (Phase 5+)
- Related KV keys → bundle into one JSON (`settings:strategyBundle`)
- Never rely on React state for data that must survive refresh → use D1 when possible
- "All Session" view = D1 query (`?hours=12&side=sell`)

### Phase 6 — Bottom Panel (Locked)
- `panel-bottom` has fixed `min-height` + `max-height: 38vh`
- Sell Desk is **pinned outside** scroll zone (never inside positions-zone)
- Positions table is unified (10 columns) with `_rowType: "open" | "closed"`
- Active/All Session toggle is in panel header

## CURRENT PRIORITIES (KI008)
1. **Split AI Workflow State** — Dashboard currently shares one `workflow` object between Gold and SET.
   → Split into `workflowGold` and `workflowSet` (including all related states: stageStatuses, activeStageIdx, workflowDone, etc.)
2. Recheck Portfolio Battlefield tab after split
3. Clean dead CSS in `dashboard.css` (low priority)

## KNOWN ISSUES
- KI008: Gold/SET share same AI workflow state (highest priority)
- Others are documented in `lessons_learned.md`

## WORKFLOW WITH CLAUDE
- Always read `CLAUDE.md` + `masterseed.md` + `lessons_learned.md` for full context when needed.
- Prefer small, safe changes (one logical fix at a time)
- After edits: Show clear diff summary and files changed
- Never assume project panel files are up-to-date — always ask for latest GitHub version

**When in doubt**: Refer to `masterseed.md` and `lessons_learned.md`.

Ready to work.
