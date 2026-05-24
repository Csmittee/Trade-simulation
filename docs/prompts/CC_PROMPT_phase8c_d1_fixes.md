> **STATUS: ✅ COMPLETE — Phase 8c executed 2026-05-24**
> Two-panel layout, ghost buy 24h filter, delete SQL generator, scroll/sticky header fixes.
> Worker: `before=` param added to GET /api/trades.
> Committed: `feat: D1 tab two-panel layout, scroll, ghost fix, SQL toggle, delete generator (Phase 8c)`
> **Worker note:** Must manually paste index.js into Cloudflare Worker editor → Save & Deploy (L010).

---

# CC PROMPT — Phase 8c: D1 Tab Complete Overhaul
# Paste this entire block into Claude Code

---

## STEP 1 — Read context first (mandatory)
Read `masterseed.md` and `lessons_learned.md` from repo root.
Then read fresh from repo:
- `src/pages/D1Tab.jsx`
- `src/dashboard.css`
- `workers/gold-proxy/index.js`

Do NOT assume content matches previous sessions (L033, L075).

---

## OVERVIEW — Full D1 Tab rebuild

Two problems to solve together:
1. Several UX bugs (scroll, back button, ghost data, dangerous reset button)
2. Layout wastes space — controls take 60% of screen, results are cramped

Solution: **Two-panel side-by-side layout**
- LEFT panel (fixed ~280px): query selector + input fields + action buttons
- RIGHT panel (flex remaining): results table with full scroll from near top

The left panel has a hide/show toggle so user can collapse it for maximum result space.

---

## NEW LAYOUT — `D1Tab.jsx`

```
┌─────────────────────────────────────────────────────────────────┐
│  🗄 D1 Query Builder  [← hide controls]              94 records │
├──────────────────┬──────────────────────────────────────────────┤
│  LEFT (280px)    │  RIGHT (flex)                                │
│                  │                                              │
│  Query buttons   │  ┌──────────────────────────────────────┐   │
│  (2-col grid)    │  │ OPENED  SYMBOL  MKT  SIDE  QTY  ...  │   │
│                  │  ├──────────────────────────────────────┤   │
│  ── divider ──   │  │ May 24  GULF    set  BUY   400  ...  │   │
│                  │  │ May 23  TRUE    set  BUY   2400 ...  │   │
│  Input fields    │  │ ...                                   │   │
│  for selected    │  │ (scrolls here)                        │   │
│  query           │  └──────────────────────────────────────┘   │
│                  │                                              │
│  [Fetch Results] │  [Generate Delete SQL]  ← ghost buys only   │
│  [Get SQL]       │                                              │
│                  │  ┌──────────────────────────────────────┐   │
│                  │  │  Generated SQL (when Get SQL clicked) │   │
│                  │  │  DELETE FROM trades WHERE id IN (... │   │
│                  │  │                      [Copy]          │   │
│                  │  └──────────────────────────────────────┘   │
└──────────────────┴──────────────────────────────────────────────┘
```

When left panel is hidden: full-width results, small "show controls ▶" button top-left.

---

## QUERY LIST — 8 queries (Confirm Reset SQL removed — too dangerous)

```js
const QUERIES = [
  { id: 'recent',   label: 'Recent Trades',  icon: '🕐', mode: 'read' },
  { id: 'symbol',   label: 'By Symbol',      icon: '🔍', mode: 'read' },
  { id: 'ghost',    label: 'Ghost Buys',     icon: '👻', mode: 'read' },
  { id: 'executor', label: 'By Executor',    icon: '🤖', mode: 'read' },
  { id: 'trash',    label: 'Find Trash',     icon: '🗑',  mode: 'read' },
  { id: 'summary',  label: 'P&L Summary',   icon: '📊', mode: 'read' },
  { id: 'actlog',   label: 'Activity Log',  icon: '📋', mode: 'read' },
  { id: 'dbcount',  label: 'DB Count',      icon: '🔢', mode: 'read' },
];
```

---

## STATE

```js
const [selectedQuery,  setSelectedQuery]  = useState(null);
const [fields,         setFields]         = useState({});
const [results,        setResults]        = useState([]);
const [generatedSQL,   setGeneratedSQL]   = useState('');
const [loading,        setLoading]        = useState(false);
const [error,          setError]          = useState('');
const [showSQL,        setShowSQL]        = useState(false);
const [copied,         setCopied]         = useState(false);
const [leftCollapsed,  setLeftCollapsed]  = useState(false);
const [deleteSQL,      setDeleteSQL]      = useState('');
```

Reset `results`, `error`, `generatedSQL`, `deleteSQL`, `showSQL` when `selectedQuery` changes.

---

## INPUT FIELDS PER QUERY

**recent:** Period dropdown (Today / Last 7 days / Last 30 days / All time), Side dropdown (All / Buy / Sell)

**symbol:** Text input (symbol, placeholder "e.g. GULF"), Side dropdown (All / Buy / Sell)

**ghost:** No inputs. Description: "Open buys older than 24h with no exit price — orphaned records from previous sessions"

**executor:** Dropdown (All / Manual / Preset Strategy / AI Workflow)

**trash:** No inputs. Description: "Records with missing critical fields"

**summary:** Group by dropdown (Day / Week / Month)

**actlog:** Period dropdown (Today / Last 7 days / Last 30 days), Type dropdown (All / buy / sell / strategy / block)

**dbcount:** No inputs. Description: "Total counts across the trades table"

---

## FETCH LOGIC

```js
const WORKER = config.workers.base; // from config.js

function getFromDate(period) {
  if (period === 'today') return new Date().toISOString().slice(0, 10);
  if (period === '7d')  { const d = new Date(); d.setDate(d.getDate()-7);  return d.toISOString().slice(0,10); }
  if (period === '30d') { const d = new Date(); d.setDate(d.getDate()-30); return d.toISOString().slice(0,10); }
  return null;
}

async function fetchResults(queryId, fields) {
  const params = new URLSearchParams({ limit: 200 });

  if (queryId === 'recent') {
    const from = getFromDate(fields.period || '7d');
    if (from) params.set('from', from);
    if (fields.side && fields.side !== 'all') params.set('side', fields.side);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === 'symbol') {
    let sym = (fields.symbol || '').trim().toUpperCase();
    if (sym && !sym.includes('.')) sym += '.BK';
    if (sym) params.set('symbol', sym);
    if (fields.side && fields.side !== 'all') params.set('side', fields.side);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === 'ghost') {
    // Only orphans older than 24h — excludes today's active positions
    const cutoff = new Date(Date.now() - 24*3600*1000).toISOString().slice(0,10);
    const res = await fetch(`${WORKER}/api/trades?open=true&before=${cutoff}&limit=200`);
    return (await res.json()).data || [];
  }
  if (queryId === 'executor') {
    if (fields.executor && fields.executor !== 'all') params.set('executor', fields.executor);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === 'trash') {
    const res = await fetch(`${WORKER}/api/trades?trash=true&limit=200`);
    return (await res.json()).data || [];
  }
  if (queryId === 'summary') {
    const res = await fetch(`${WORKER}/api/trades/summary?group=${fields.group || 'day'}`);
    return (await res.json()).data || [];
  }
  if (queryId === 'actlog') {
    const from = getFromDate(fields.period || '7d');
    if (from) params.set('from', from);
    if (fields.type && fields.type !== 'all') params.set('type', fields.type);
    const res = await fetch(`${WORKER}/api/logs?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === 'dbcount') {
    const res = await fetch(`${WORKER}/api/trades/count`);
    const d = await res.json();
    return d.data ? [d.data] : [];
  }
  return [];
}
```

---

## SQL GENERATOR PER QUERY

Build `generateSQL(queryId, fields, results)` that returns a SQL string:

**recent:**
```sql
SELECT * FROM trades
WHERE opened_at >= '[FROM]'[AND side = '[SIDE]']
ORDER BY opened_at DESC LIMIT 200;
```

**symbol:**
```sql
SELECT * FROM trades
WHERE symbol = '[SYMBOL]'[AND side = '[SIDE]']
ORDER BY opened_at DESC LIMIT 200;
```

**ghost:**
```sql
SELECT * FROM trades
WHERE side = 'buy'
AND (exit_price IS NULL OR closed_at IS NULL)
AND opened_at < '[CUTOFF]'
ORDER BY opened_at DESC;
```

**executor:** Show the appropriate WHERE clause for the selected executor value.

**trash:**
```sql
SELECT * FROM trades
WHERE symbol IS NULL OR market IS NULL
   OR qty IS NULL OR entry_price IS NULL OR opened_at IS NULL;
```

**summary:**
```sql
SELECT DATE(closed_at) as period, COUNT(*) as trades,
       ROUND(SUM(pnl),2) as total_pnl,
       SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN pnl<=0 THEN 1 ELSE 0 END) as losses
FROM trades WHERE side='sell' AND pnl IS NOT NULL
GROUP BY DATE(closed_at) ORDER BY period DESC;
```

**actlog:**
```sql
SELECT * FROM activity_log
WHERE created_at >= '[FROM]'[AND type='[TYPE]']
ORDER BY created_at DESC LIMIT 200;
```

**dbcount:**
```sql
SELECT COUNT(*) as total_trades,
       COUNT(CASE WHEN side='buy' THEN 1 END) as buys,
       COUNT(CASE WHEN side='sell' THEN 1 END) as sells,
       COUNT(CASE WHEN side='buy' AND exit_price IS NULL THEN 1 END) as open_buys
FROM trades;
```

---

## DELETE SQL GENERATOR — Ghost Buys only

After Ghost Buys results load AND results.length > 0, show button below table:
`[⚠️ Generate Delete SQL for these ${results.length} records]`

Clicking builds:
```sql
-- ⚠️ Deletes [N] ghost buy records permanently
-- Paste ONLY in Cloudflare Dashboard → D1 → tts-db → Console → Run
DELETE FROM trades
WHERE id IN (
  '[id1]',
  '[id2]',
  ...
);
-- Verify after: SELECT COUNT(*) FROM trades WHERE side='buy' AND exit_price IS NULL;
```

Store in `deleteSQL` state. Show in same SQL block with red warning banner above and copy button.

---

## RESULTS TABLE COLUMNS

**trades queries (recent, symbol, ghost, executor, trash):**
opened_at (short: "May 23 04:01"), symbol, market, side, qty, entry_price, exit_price, pnl, strategy, closed_at

**summary:** period, trades, total_pnl, wins, losses

**actlog:** created_at, type, market, message, detail

**dbcount:** total_trades, buys, sells, open_buys

Row coloring:
- sell row with pnl > 0 → `.d1-row--win` (green tint)
- sell row with pnl < 0 → `.d1-row--loss` (red tint)
- buy with no exit_price → `.d1-row--ghost` (orange tint)

---

## CSS — Replace existing D1 classes in `dashboard.css`

Remove all existing `.d1-*` classes and replace with:

```css
/* ── D1 Query Builder — Phase 8c two-panel layout ─────────────────────────── */
.d1-wrap {
  display: flex; height: calc(100vh - 120px); overflow: hidden;
  font-size: 12px;
}

/* LEFT PANEL */
.d1-left {
  width: 280px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  overflow-y: auto; padding: 16px 12px;
  gap: 10px; transition: width 0.2s;
}
.d1-left.collapsed { width: 0; padding: 0; overflow: hidden; }

.d1-left-header { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.d1-left-sub    { font-size: 10px; color: var(--text-muted); line-height: 1.4; }

.d1-query-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
}
.d1-query-btn {
  padding: 8px 6px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-secondary);
  color: var(--text-muted); font-size: 10px; font-weight: 600;
  cursor: pointer; text-align: center; line-height: 1.3;
  transition: all 0.15s;
}
.d1-query-btn:hover  { border-color: var(--accent); color: var(--accent); }
.d1-query-btn.active { border-color: var(--accent); background: rgba(59,130,246,0.15); color: var(--accent); }

.d1-divider { border: none; border-top: 1px solid var(--border); margin: 4px 0; }

.d1-query-title { font-size: 12px; font-weight: 700; color: var(--text-primary); }
.d1-query-desc  { font-size: 10px; color: var(--text-muted); line-height: 1.4; }

.d1-field { display: flex; flex-direction: column; gap: 3px; }
.d1-field label { font-size: 9px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
.d1-field select,
.d1-field input  {
  background: var(--bg-primary, #0f1117); border: 1px solid var(--border);
  border-radius: 4px; padding: 5px 8px; font-size: 11px;
  color: var(--text-primary); width: 100%;
}

.d1-action-row { display: flex; gap: 6px; margin-top: 4px; }
.d1-fetch-btn {
  flex: 1; padding: 7px; background: var(--accent, #3b82f6);
  color: #fff; border: none; border-radius: 6px;
  font-size: 11px; font-weight: 700; cursor: pointer;
}
.d1-fetch-btn:hover { opacity: 0.85; }
.d1-sql-btn {
  padding: 7px 10px; background: transparent;
  border: 1px solid var(--border); border-radius: 6px;
  font-size: 11px; color: var(--text-muted); cursor: pointer;
}
.d1-sql-btn:hover  { border-color: var(--accent); color: var(--accent); }
.d1-sql-btn.active { border-color: var(--accent); color: var(--accent); background: rgba(59,130,246,0.1); }

/* RIGHT PANEL */
.d1-right {
  flex: 1; display: flex; flex-direction: column;
  overflow: hidden; padding: 12px 16px; gap: 10px;
}

.d1-right-header {
  display: flex; align-items: center; gap: 10px;
  flex-shrink: 0;
}
.d1-toggle-btn {
  background: none; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-muted); font-size: 10px; padding: 3px 8px; cursor: pointer;
  white-space: nowrap;
}
.d1-toggle-btn:hover { color: var(--text-primary); }
.d1-right-title { font-size: 12px; color: var(--text-muted); flex: 1; }
.d1-record-count { font-size: 11px; font-weight: 700; color: var(--text-primary); }

.d1-table-wrap {
  flex: 1; overflow-x: auto; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 6px;
  min-height: 0; /* critical for flex scroll */
}
.d1-table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: monospace; }
.d1-table th {
  background: var(--bg-secondary); color: var(--text-muted);
  padding: 5px 10px; text-align: left; font-size: 9px;
  text-transform: uppercase; letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border); white-space: nowrap;
  position: sticky; top: 0; z-index: 1;
}
.d1-table td {
  padding: 4px 10px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
  color: var(--text-primary); white-space: nowrap;
}
.d1-table tr:last-child td { border-bottom: none; }
.d1-table tr:hover td { background: var(--bg-hover); }
.d1-row--win   td { background: rgba(34,197,94,0.04); }
.d1-row--loss  td { background: rgba(239,68,68,0.04); }
.d1-row--ghost td { background: rgba(245,158,11,0.06); }
.d1-pnl-up   { color: var(--green, #22c55e); font-weight: 700; }
.d1-pnl-down { color: var(--red, #ef4444); font-weight: 700; }

.d1-sql-panel {
  flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;
}
.d1-sql-block {
  background: #0a0c10; border: 1px solid var(--border);
  border-radius: 6px; padding: 12px; font-family: monospace;
  font-size: 11px; color: #7dd3fc; white-space: pre-wrap;
  line-height: 1.6; max-height: 160px; overflow-y: auto;
}
.d1-sql-actions { display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.d1-copy-btn {
  padding: 5px 14px; background: transparent;
  border: 1px solid var(--border); border-radius: 6px;
  font-size: 11px; color: var(--text-muted); cursor: pointer;
}
.d1-copy-btn:hover   { border-color: var(--accent); color: var(--accent); }
.d1-copy-btn.success { border-color: var(--green, #22c55e); color: var(--green, #22c55e); }

.d1-warning-banner {
  background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
  border-radius: 6px; padding: 8px 12px; font-size: 11px;
  color: var(--red, #ef4444); font-weight: 600;
}
.d1-delete-btn {
  align-self: flex-start; padding: 6px 14px;
  background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4);
  border-radius: 6px; font-size: 11px; font-weight: 700;
  color: var(--red, #ef4444); cursor: pointer;
}
.d1-delete-btn:hover { background: rgba(239,68,68,0.25); }

.d1-loading { padding: 32px; text-align: center; color: var(--text-muted); }
.d1-empty   { padding: 32px; text-align: center; color: var(--text-muted); }
.d1-error   { padding: 12px; background: rgba(239,68,68,0.1); border-radius: 6px; color: var(--red, #ef4444); }

.d1-instructions {
  flex-shrink: 0;
  background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.2);
  border-radius: 6px; padding: 10px 14px;
}
.d1-instructions-title { font-size: 10px; font-weight: 700; color: var(--gold, #f59e0b); margin-bottom: 6px; }
.d1-instructions ol { margin: 0; padding-left: 16px; }
.d1-instructions li { font-size: 10px; color: var(--text-muted); line-height: 1.6; }
.d1-instructions code {
  background: rgba(255,255,255,0.08); padding: 1px 4px;
  border-radius: 3px; font-family: monospace; font-size: 10px;
  color: var(--text-primary);
}
```

---

## Worker fix — `workers/gold-proxy/index.js`

In the GET `/api/trades` handler, add `before` param support after the existing `from` block:
```js
const before = url.searchParams.get('before') || null;
if (before) { query += " AND opened_at < ?"; params.push(before); }
```

---

## STEP 2 — Write complete replacement files

- `src/pages/D1Tab.jsx`
- `src/dashboard.css`
- `workers/gold-proxy/index.js`

Commit: `feat: D1 tab two-panel layout, scroll, ghost fix, SQL toggle, delete generator (Phase 8c)`

After committing remind user: paste `workers/gold-proxy/index.js` into Cloudflare Worker editor manually → Save & Deploy (L010).

---

## STEP 3 — Update docs
Update `masterseed.md` and `lessons_learned.md`.
Commit: `docs: update after Phase 8c`

---

## CRITICAL RULES
- Read all files fresh from repo before writing (L033, L075)
- Complete files only — never patches (L074)
- Worker: user pastes manually in Cloudflare — never auto-deploy (L010)
- CSS: remove ALL old .d1-* classes, replace with new ones — no duplicates
- `min-height: 0` on `.d1-table-wrap` is critical for flex scroll to work
- Sticky table headers require `position: sticky; top: 0; z-index: 1` on `th`
