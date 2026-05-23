# CC PROMPT — Phase 8b: D1 Tab Live Results
# Upgrade D1 tab to show real data directly + SQL generator only for destructive ops
# Paste this entire block into Claude Code

---

## STEP 1 — Read context first (mandatory)
Read `masterseed.md` and `lessons_learned.md` from repo root before anything else.

Then read these files fresh from the repo:
- `workers/gold-proxy/index.js`
- `src/pages/D1Tab.jsx`
- `src/dashboard.css`

Do NOT assume content matches previous sessions. Read fresh (L033, L075).

---

## OVERVIEW

The D1 tab currently generates SQL for copy-paste only.

Upgrade to TWO modes:
- **READ queries** → fetch real data from Worker, display as table in the tab
- **WRITE/DELETE queries** → SQL generator only (unchanged) — user pastes in Cloudflare console

---

## PART 1 — Worker changes (`workers/gold-proxy/index.js`)

### Extend GET `/api/trades` with new query params

Current params: `market`, `symbol`, `limit`

Add these new params to the existing GET handler:

**`open=true`** — ghost buys (buy with no exit_price):
```js
if (url.searchParams.get('open') === 'true') {
  query += " AND side = 'buy' AND (exit_price IS NULL OR closed_at IS NULL)";
}
```

**`executor=manual|preset|ai`** — filter by who placed the trade:
```js
const executor = url.searchParams.get('executor');
if (executor === 'manual')  { query += " AND strategy = 'manual'"; }
if (executor === 'preset')  { query += " AND strategy != 'manual' AND strategy NOT LIKE 'ai_%'"; }
if (executor === 'ai')      { query += " AND (strategy LIKE 'ai_%' OR strategy = 'ai_workflow')"; }
```

**`trash=true`** — incomplete/malformed records:
```js
if (url.searchParams.get('trash') === 'true') {
  query += " AND (symbol IS NULL OR market IS NULL OR qty IS NULL OR entry_price IS NULL OR opened_at IS NULL)";
}
```

**`from` date param** — already supported? If not, add:
```js
const from = url.searchParams.get('from');
if (from) { query += " AND opened_at >= ?"; params.push(from); }
```

**`side` param** — filter buy or sell:
```js
const side = url.searchParams.get('side');
if (side && (side === 'buy' || side === 'sell')) {
  query += " AND side = ?"; params.push(side);
}
```

### Add new GET `/api/trades/summary` route

Add this route check in the main fetch handler (before the existing `/api/trades` check):
```js
if (url.pathname === '/api/trades/summary') return handleTradesSummary(request, env);
```

Add the handler function:
```js
async function handleTradesSummary(request, env) {
  if (!env.TTS_DB) return jsonResponse({ success: false, error: 'D1 not configured' }, 503);
  try {
    const url   = new URL(request.url);
    const group = url.searchParams.get('group') || 'day'; // day | week | month

    let dateFn;
    if (group === 'month') dateFn = "strftime('%Y-%m', closed_at)";
    else if (group === 'week') dateFn = "strftime('%Y-W%W', closed_at)";
    else dateFn = "DATE(closed_at)";

    const { results } = await env.TTS_DB.prepare(`
      SELECT
        ${dateFn} as period,
        COUNT(*) as trades,
        ROUND(SUM(pnl), 2) as total_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
      FROM trades
      WHERE side = 'sell' AND pnl IS NOT NULL AND closed_at IS NOT NULL
      GROUP BY ${dateFn}
      ORDER BY period DESC
      LIMIT 90
    `).all();

    return jsonResponse({ success: true, count: results.length, data: results });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, data: [] }, 500);
  }
}
```

Also add count endpoint for Confirm Reset check:
Add `if (url.pathname === '/api/trades/count') return handleTradesCount(request, env);`

```js
async function handleTradesCount(request, env) {
  if (!env.TTS_DB) return jsonResponse({ success: false, error: 'D1 not configured' }, 503);
  try {
    const { results } = await env.TTS_DB.prepare(`
      SELECT
        COUNT(*) as total_trades,
        COUNT(CASE WHEN side='buy' THEN 1 END) as buys,
        COUNT(CASE WHEN side='sell' THEN 1 END) as sells,
        COUNT(CASE WHEN side='buy' AND exit_price IS NULL THEN 1 END) as open_buys
      FROM trades
    `).all();
    return jsonResponse({ success: true, data: results[0] });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
}
```

---

## PART 2 — D1Tab.jsx complete rewrite

### Query types split into READ vs WRITE:

**READ (shows live results):**
1. Recent Trades — params: period dropdown + side dropdown
2. By Symbol — params: symbol text input + side dropdown  
3. Ghost Buys — no params, one click
4. By Executor — params: executor dropdown (All/Manual/Preset/AI)
5. Find Trash Data — no params, one click
6. P&L Summary — params: group by (Day/Week/Month)
7. Activity Log — params: period + type dropdown
8. Database Count — no params, shows total counts (use for Confirm Reset check)

**WRITE/SQL Generator only:**
9. Confirm Reset — generates DELETE SQL (destructive, never execute from here)

### Component structure

```jsx
const WORKER = config.workers.base;

const QUERIES = [
  { id: 'recent',    label: 'Recent Trades',   icon: '🕐', mode: 'read' },
  { id: 'symbol',    label: 'By Symbol',        icon: '🔍', mode: 'read' },
  { id: 'ghost',     label: 'Ghost Buys',       icon: '👻', mode: 'read' },
  { id: 'executor',  label: 'By Executor',      icon: '🤖', mode: 'read' },
  { id: 'trash',     label: 'Find Trash Data',  icon: '🗑', mode: 'read' },
  { id: 'summary',   label: 'P&L Summary',      icon: '📊', mode: 'read' },
  { id: 'actlog',    label: 'Activity Log',     icon: '📋', mode: 'read' },
  { id: 'dbcount',   label: 'DB Count',         icon: '🔢', mode: 'read' },
  { id: 'reset_sql', label: 'Confirm Reset SQL', icon: '⚠️', mode: 'sql' },
];
```

### Fetch logic per query type

Build a `fetchResults(queryId, fields)` async function:

```js
async function fetchResults(queryId, fields) {
  const base = WORKER;
  let url, data;

  if (queryId === 'recent') {
    const from = getFromDate(fields.period); // Today/7d/30d
    const params = new URLSearchParams({ limit: 200 });
    if (from) params.set('from', from);
    if (fields.side && fields.side !== 'all') params.set('side', fields.side);
    const res = await fetch(`${base}/api/trades?${params}`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'symbol') {
    const params = new URLSearchParams({ limit: 200 });
    if (fields.symbol) params.set('symbol', fields.symbol.toUpperCase().includes('.BK') ? fields.symbol : fields.symbol + '.BK');
    if (fields.side && fields.side !== 'all') params.set('side', fields.side);
    const res = await fetch(`${base}/api/trades?${params}`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'ghost') {
    const res = await fetch(`${base}/api/trades?open=true&limit=200`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'executor') {
    const params = new URLSearchParams({ limit: 200 });
    if (fields.executor && fields.executor !== 'all') params.set('executor', fields.executor);
    const res = await fetch(`${base}/api/trades?${params}`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'trash') {
    const res = await fetch(`${base}/api/trades?trash=true&limit=200`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'summary') {
    const res = await fetch(`${base}/api/trades/summary?group=${fields.group || 'day'}`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'actlog') {
    const from = getFromDate(fields.period);
    const params = new URLSearchParams({ limit: 200 });
    if (from) params.set('from', from);
    if (fields.type && fields.type !== 'all') params.set('type', fields.type);
    const res = await fetch(`${base}/api/logs?${params}`);
    data = await res.json();
    return data.data || [];
  }

  if (queryId === 'dbcount') {
    const res = await fetch(`${base}/api/trades/count`);
    data = await res.json();
    return data.data ? [data.data] : [];
  }

  return [];
}

function getFromDate(period) {
  const now = new Date();
  if (period === 'today') return now.toISOString().slice(0, 10);
  if (period === '7d')  { now.setDate(now.getDate() - 7);  return now.toISOString().slice(0, 10); }
  if (period === '30d') { now.setDate(now.getDate() - 30); return now.toISOString().slice(0, 10); }
  return null; // all time
}
```

### Results table

Render results as a scrollable table. Columns depend on query type:

- **trades queries** (recent, symbol, ghost, executor, trash): id(short), symbol, market, side, qty, entry_price, exit_price, pnl, strategy, opened_at, closed_at
- **summary**: period, trades, total_pnl, wins, losses
- **actlog**: created_at, type, symbol, message, detail
- **dbcount**: total_trades, buys, sells, open_buys

Show row count above table: `${results.length} records found`

Color rows: sell rows with pnl > 0 → subtle green tint, pnl < 0 → subtle red tint. Ghost buys (no exit_price) → subtle orange tint.

### SQL Generator (reset_sql only)

For the `reset_sql` query, skip fetch entirely. Show this generated SQL with copy button:
```sql
-- ⚠️  WARNING: This permanently deletes ALL trade records
-- Run ONLY in Cloudflare D1 console after confirming you want a full reset
DELETE FROM trades;
DELETE FROM activity_log;
-- Verify with: SELECT COUNT(*) FROM trades;
```

Show a red warning banner above: "This SQL deletes all data permanently. Only paste in Cloudflare console after full confirmation."

### Loading + error states

- Loading: show spinner text "Fetching from D1..."
- Error: show red error message with the error text
- Empty: show "No records found for this query"

---

## PART 3 — `dashboard.css` additions

Append at end of file:

```css
/* ── Phase 8b — D1 live results table ────────────────────────────────────── */
.d1-results-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; color: var(--text-muted); margin-bottom: 6px;
}
.d1-results-count { font-weight: 700; color: var(--text-primary); }
.d1-table-wrap { overflow-x: auto; border-radius: 6px; border: 1px solid var(--border); }
.d1-table {
  width: 100%; border-collapse: collapse; font-size: 11px;
  font-family: monospace;
}
.d1-table th {
  background: var(--bg-secondary); color: var(--text-muted);
  padding: 6px 10px; text-align: left; font-size: 9px;
  text-transform: uppercase; letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
.d1-table td {
  padding: 5px 10px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
  color: var(--text-primary); white-space: nowrap;
}
.d1-table tr:last-child td { border-bottom: none; }
.d1-table tr:hover td { background: var(--bg-hover); }
.d1-row--win  td { background: rgba(34,197,94,0.04); }
.d1-row--loss td { background: rgba(239,68,68,0.04); }
.d1-row--ghost td { background: rgba(245,158,11,0.06); }
.d1-pnl-up   { color: var(--green, #22c55e); font-weight: 700; }
.d1-pnl-down { color: var(--red, #ef4444); font-weight: 700; }
.d1-warning-banner {
  background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
  border-radius: 6px; padding: 12px; font-size: 12px;
  color: var(--red, #ef4444); font-weight: 600; margin-bottom: 12px;
}
.d1-loading { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.d1-empty   { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.d1-error   { padding: 12px; background: rgba(239,68,68,0.1); border-radius: 6px; color: var(--red, #ef4444); font-size: 12px; }
```

---

## WHAT NOT TO TOUCH
- Gold tab — no changes
- SET tab — no changes  
- Portfolio tab — no changes
- KV logic — no changes
- Existing Worker routes — only ADD new params and new routes, never modify existing logic

---

## STEP 2 — Write complete files

Write complete files (no patches) for:
- `workers/gold-proxy/index.js`
- `src/pages/D1Tab.jsx`
- `src/dashboard.css`

Commit: `feat: D1 tab live results — real data from Worker, SQL generator for destructive ops (Phase 8b)`

**Note for Worker:** After committing index.js to GitHub, remind the user they must manually paste the new index.js content into the Cloudflare Worker editor and click Save & Deploy. GitHub is NOT connected to the Worker (L010).

---

## STEP 3 — Update docs

Update `masterseed.md` (Phase 8b complete).
Append new lessons to `lessons_learned.md`.

Commit: `docs: update masterseed and lessons_learned after Phase 8b`

---

## CRITICAL RULES
- Read files fresh from repo before writing (L033, L075)
- Write complete files — never patches (L074)
- Worker: NEVER connect GitHub to Worker deployment — user pastes manually (L010)
- New Worker routes added BEFORE existing route checks in the main handler
- CSS appended to src/dashboard.css only
- config.js WORKER_BASE already available in D1Tab via import config
