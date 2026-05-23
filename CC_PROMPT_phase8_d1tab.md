# CC PROMPT — Phase 8: D1 Query Tab
# New 4th tab — click-based SQL generator, no direct execution
# Paste this entire block into Claude Code

---

## STEP 1 — Read context first (mandatory)
Read `masterseed.md` and `lessons_learned.md` from repo root before anything else.

Then read these files fresh from the repo:
- `src/pages/Dashboard.jsx`
- `src/dashboard.css`

Do NOT assume content matches previous sessions. Read fresh (L033, L075).

---

## OVERVIEW

Add a new **D1** tab as the 4th tab (after Portfolio). This is a **SQL generator only** — it builds queries the user copies and pastes into the Cloudflare D1 console. No direct database execution from the frontend. No new Worker routes needed.

The tab has a clean menu of query types. User picks one, fills simple fields, clicks Generate → sees the exact SQL to copy.

---

## D1 TABLE SCHEMA (confirmed from Worker)

```sql
-- trades table
CREATE TABLE trades (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  market      TEXT NOT NULL,         -- "gold" | "set"
  side        TEXT NOT NULL,         -- "buy" | "sell"
  qty         REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price  REAL,                  -- null = still open (ghost buy)
  pnl         REAL,                  -- null = still open
  strategy    TEXT DEFAULT "manual", -- "manual" | strategy name | "ai_workflow"
  opened_at   TEXT NOT NULL,         -- ISO timestamp
  closed_at   TEXT,                  -- null = still open
  sim_mode    INTEGER DEFAULT 1      -- 1=simulation, 0=live
);

-- activity_log table (used by /api/logs)
CREATE TABLE activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT,
  market     TEXT,
  symbol     TEXT,
  message    TEXT,
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## QUERY MENU — 8 query types

### 1. Recent Trades
**Fields:** Period (Today / Last 7 days / Last 30 days / Custom date range)
**Generated SQL:**
```sql
SELECT * FROM trades
WHERE opened_at >= '[DATE]'
ORDER BY opened_at DESC;
```

### 2. By Symbol
**Fields:** Symbol input (e.g. GULF.BK), Side (All / Buy / Sell)
**Generated SQL:**
```sql
SELECT * FROM trades
WHERE symbol = '[SYMBOL]'
[AND side = '[SIDE]']
ORDER BY opened_at DESC;
```

### 3. Ghost Buys — open positions never closed
**Fields:** None (one click)
**Description shown:** "Buys with no exit_price — positions that vanished from radar"
**Generated SQL:**
```sql
SELECT * FROM trades
WHERE side = 'buy'
AND (exit_price IS NULL OR closed_at IS NULL)
ORDER BY opened_at DESC;
```

### 4. By Executor — who placed the trade
**Fields:** Executor (All / Manual / Preset Strategy / AI Workflow)
**Generated SQL:**
- Manual: `WHERE strategy = 'manual'`
- Preset: `WHERE strategy != 'manual' AND strategy NOT LIKE 'ai_%'`
- AI: `WHERE strategy LIKE 'ai_%' OR strategy = 'ai_workflow'`

### 5. Find Trash Data — incomplete or malformed records
**Fields:** None (one click)
**Description:** "Records missing critical fields"
**Generated SQL:**
```sql
SELECT * FROM trades
WHERE symbol IS NULL
   OR market IS NULL
   OR qty IS NULL
   OR entry_price IS NULL
   OR opened_at IS NULL
ORDER BY opened_at DESC;
```

### 6. Confirm Reset — verify database is empty after reset
**Fields:** None (one click)
**Description:** "Run this after pressing Reset to confirm all trades are deleted"
**Generated SQL:**
```sql
SELECT COUNT(*) as total_trades,
       COUNT(CASE WHEN side='buy' THEN 1 END) as buys,
       COUNT(CASE WHEN side='sell' THEN 1 END) as sells
FROM trades;
-- Expected after reset: total_trades = 0
```

### 7. P&L Summary by Date
**Fields:** Group by (Day / Week / Month)
**Generated SQL:**
```sql
SELECT DATE(closed_at) as date,
       COUNT(*) as trades,
       SUM(pnl) as total_pnl,
       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
FROM trades
WHERE side = 'sell' AND pnl IS NOT NULL
GROUP BY DATE(closed_at)
ORDER BY date DESC;
```

### 8. Activity Log
**Fields:** Period (Today / Last 7 days), Type filter (All / buy / sell / block / strategy)
**Generated SQL:**
```sql
SELECT * FROM activity_log
WHERE created_at >= '[DATE]'
[AND type = '[TYPE]']
ORDER BY created_at DESC
LIMIT 200;
```

---

## UI DESIGN

### Tab header
Add "🗄 D1" as the 4th tab in Dashboard.jsx tab row, after Portfolio.

### D1 tab layout (new page component `src/pages/D1Tab.jsx`)

```
┌─────────────────────────────────────────────┐
│  🗄 D1 Query Builder                         │
│  Generate SQL → copy → paste in Cloudflare  │
│                                              │
│  [Query Type Selector — 8 buttons in grid]  │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  [Selected query name + description]    │ │
│  │  [Simple input fields for this query]   │ │
│  │  [Generate SQL] button                  │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  Generated SQL:                         │ │
│  │  SELECT * FROM trades WHERE...          │ │
│  │                    [Copy to clipboard]  │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  Where to run this:                          │
│  Cloudflare Dashboard → D1 → tts-db →       │
│  Console → paste → Run                      │
└─────────────────────────────────────────────┘
```

### Behaviour
- Query type buttons: clicking one shows its input fields below
- Input fields are simple: text inputs, dropdowns, date pickers (HTML date input)
- "Generate SQL" button builds the query string with inputs substituted
- SQL output shown in a `<pre>` or `<textarea readonly>` block with monospace font
- "Copy" button copies to clipboard, changes to "Copied ✓" for 2 seconds
- Instructions section at bottom always visible — tells user exactly where to paste

---

## IMPLEMENTATION

### New file: `src/pages/D1Tab.jsx`

Pure React component. No props needed from Dashboard except `activeTab` guard.
All state is local (selected query type, field values, generated SQL, copied state).

Use `useState` for:
- `selectedQuery` — which of the 8 queries is active (default: null, show picker)
- `fields` — object of current field values for the selected query
- `generatedSQL` — string output
- `copied` — boolean for copy button feedback

Date helper: for "Today" use `new Date().toISOString().slice(0,10)`, for "Last 7 days" subtract 7 days, etc.

### `src/pages/Dashboard.jsx` changes

1. Import `D1Tab` at the top
2. Add `"d1"` to the tab list — tab button label: `🗄 D1`
3. Add render: `{activeTab === "d1" && <D1Tab />}`

### `src/dashboard.css` additions (append at end)

```css
/* ── Phase 8 — D1 Query Tab ───────────────────────────────────────────────── */
.d1-tab {
  padding: 24px; max-width: 800px; margin: 0 auto;
  display: flex; flex-direction: column; gap: 20px;
}
.d1-header { }
.d1-header h2 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px; }
.d1-header p  { font-size: 12px; color: var(--text-muted); margin: 0; }

.d1-query-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
}
.d1-query-btn {
  padding: 10px 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-secondary);
  color: var(--text-muted); font-size: 11px; font-weight: 600;
  cursor: pointer; text-align: center; transition: all 0.15s;
  line-height: 1.3;
}
.d1-query-btn:hover  { border-color: var(--accent); color: var(--accent); }
.d1-query-btn.active { border-color: var(--accent); background: rgba(59,130,246,0.15); color: var(--accent); }

.d1-query-panel {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;
}
.d1-query-title { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.d1-query-desc  { font-size: 11px; color: var(--text-muted); }
.d1-fields      { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.d1-field       { display: flex; flex-direction: column; gap: 4px; }
.d1-field label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
.d1-field select,
.d1-field input {
  background: var(--bg-primary, #0f1117); border: 1px solid var(--border);
  border-radius: 4px; padding: 6px 10px; font-size: 12px;
  color: var(--text-primary); min-width: 140px;
}
.d1-generate-btn {
  padding: 8px 20px; background: var(--accent, #3b82f6); color: #fff;
  border: none; border-radius: 6px; font-size: 12px; font-weight: 700;
  cursor: pointer; align-self: flex-end;
}
.d1-generate-btn:hover { opacity: 0.85; }

.d1-output {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 10px;
}
.d1-output-label { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.d1-sql-block {
  background: #0a0c10; border: 1px solid var(--border);
  border-radius: 6px; padding: 14px; font-family: monospace;
  font-size: 12px; color: #7dd3fc; white-space: pre-wrap;
  line-height: 1.6; min-height: 80px;
}
.d1-copy-btn {
  align-self: flex-end; padding: 6px 16px;
  background: transparent; border: 1px solid var(--border);
  border-radius: 6px; font-size: 11px; font-weight: 600;
  color: var(--text-muted); cursor: pointer; transition: all 0.15s;
}
.d1-copy-btn:hover   { border-color: var(--accent); color: var(--accent); }
.d1-copy-btn.success { border-color: var(--green, #22c55e); color: var(--green, #22c55e); }

.d1-instructions {
  background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.2);
  border-radius: 8px; padding: 14px;
}
.d1-instructions-title { font-size: 11px; font-weight: 700; color: var(--gold, #f59e0b); margin-bottom: 8px; }
.d1-instructions ol   { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.d1-instructions li   { font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.d1-instructions code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 11px; color: var(--text-primary); }
```

---

## WHAT NOT TO TOUCH
- Gold tab — no changes
- SET tab — no changes
- Portfolio tab — no changes
- Worker / index.js — no changes
- No new API routes needed

---

## STEP 2 — Write complete files

Write complete files (no patches) for:
- `src/pages/D1Tab.jsx` (new file)
- `src/pages/Dashboard.jsx`
- `src/dashboard.css`

Commit: `feat: D1 query builder tab — click-to-generate SQL (Phase 8)`

---

## STEP 3 — Update docs

Update `masterseed.md` (Phase 8 complete, D1 tab added).
Append new lessons to `lessons_learned.md`.

Commit: `docs: update masterseed and lessons_learned after Phase 8`

---

## CRITICAL RULES
- Read files fresh from repo before writing (L033, L075)
- Write complete files — never patches (L074)
- New file D1Tab.jsx goes in src/pages/ — same folder as Dashboard, Portfolio, SetMarket
- CSS appended to src/dashboard.css only — never create a second CSS file
- No Worker changes — this tab generates SQL only, never executes it
