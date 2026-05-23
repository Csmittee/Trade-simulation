# CC PROMPT — Phase 7a: Grouped Positions Table (SET tab)
# Single file change — low risk, high value
# Paste this entire block into Claude Code

---

## STEP 1 — Read context first (mandatory)
Read `masterseed.md` and `lessons_learned.md` from repo root before anything else.

Then read these two files fresh from the repo:
- `src/pages/SetMarket.jsx`
- `src/dashboard.css`

Do NOT assume content matches previous sessions. Read fresh (L033, L075).

---

## WHAT TO CHANGE — One focused fix

The SET tab bottom positions table currently shows every individual buy as a flat row.

### New behaviour — Active view only (All Session unchanged)

Group open positions by symbol into collapsible summary rows:

**Summary row (one per symbol you hold):**
- Clicking anywhere on the row → `setActiveSymbol(sym)` — switches chart + right panel to that symbol
- Shows: symbol name, count badge (e.g. "2 buys"), total qty, avg entry price, current price, total unrealised P&L, total P&L%
- A `▶`/`▼` expand button on the right edge — clicking it (stopPropagation!) toggles child rows
- Highlight with left border accent if this symbol === activeSymbol

**Child rows (individual buys, shown when expanded):**
- Indented slightly
- Shows: time opened, qty, entry price, current price, P&L, P&L%, stop, target, strategy
- No symbol column needed (already shown in parent)

**All Session view:** keep exactly as it is today — flat closed trade rows, no grouping.

---

## IMPLEMENTATION — `SetMarket.jsx`

### 1. Add expand state (near other useState declarations)
```js
const [expandedGroups, setExpandedGroups] = useState({});
```

### 2. Add toggleGroup handler (near other useCallback handlers)
```js
const toggleGroup = useCallback((sym, e) => {
  e.stopPropagation();
  setExpandedGroups(prev => ({ ...prev, [sym]: !prev[sym] }));
}, []);
```

### 3. Add grouped positions memo (near other useMemo/derived values)
```js
const positionGroups = useMemo(() => {
  const groups = {};
  setPositions.forEach(pos => {
    if (!groups[pos.symbol]) groups[pos.symbol] = [];
    groups[pos.symbol].push(pos);
  });
  return groups;
}, [setPositions]);

const groupedSymbols = useMemo(() => Object.keys(positionGroups), [positionGroups]);
```

### 4. Replace the Active view rendering block

Find the block inside the positions table that renders `openRows` (the `.map(pos => ...)` block for `_rowType === "open"`).

Replace only the Active view rendering with this grouped version. The All Session / closed rows rendering is UNCHANGED.

The grouped render logic:
```jsx
// Active view — grouped by symbol
if (posView === "active") {
  if (groupedSymbols.length === 0) {
    return <div className="empty-state">No open positions. Select a stock and place a buy order.</div>;
  }
  return (
    <div className="positions-table positions-table--grouped">
      {groupedSymbols.map(sym => {
        const rows      = positionGroups[sym];
        const totalQty  = rows.reduce((s, p) => s + (p.qty || 0), 0);
        const totalCost = rows.reduce((s, p) => s + (p.totalCost || 0), 0);
        const totalPnl  = rows.reduce((s, p) => s + (p.unrealisedPnL || 0), 0);
        const avgEntry  = totalQty > 0 ? totalCost / totalQty : 0;
        const curPrice  = rows[0]?.currentPrice || 0;
        const pnlPct    = avgEntry > 0 ? ((curPrice - avgEntry) / avgEntry) * 100 : 0;
        const pnlUp     = totalPnl >= 0;
        const isActive  = sym === activeSymbol;
        const isExpanded = !!expandedGroups[sym];
        const count     = rows.length;

        return (
          <div key={sym} className="pos-group">
            {/* Summary row — click to switch symbol */}
            <div
              className={`pos-group-header ${isActive ? 'pos-group-header--active' : ''}`}
              onClick={() => setActiveSymbol(sym)}
            >
              <span className="pos-group-sym">
                {sym.replace('.BK', '')}
                <span className="pos-group-count">{count}</span>
              </span>
              <span className="pos-group-qty">{totalQty.toLocaleString()} shares</span>
              <span className="pos-group-entry">avg ฿{avgEntry.toFixed(2)}</span>
              <span className="pos-group-price">฿{curPrice.toFixed(2)}</span>
              <span className={`pos-group-pnl ${pnlUp ? 'pnl-up' : 'pnl-down'}`}>
                {pnlUp ? '+' : ''}฿{Math.round(totalPnl).toLocaleString()}
              </span>
              <span className={`pos-group-pct ${pnlUp ? 'pnl-up' : 'pnl-down'}`}>
                {pnlUp ? '+' : ''}{pnlPct.toFixed(2)}%
              </span>
              <button
                className="pos-group-expand"
                onClick={(e) => toggleGroup(sym, e)}
                title={isExpanded ? 'Collapse' : 'Expand buys'}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            </div>

            {/* Child rows — individual buys */}
            {isExpanded && rows.map((pos, i) => {
              const childPnlUp  = (pos.unrealisedPnL || 0) >= 0;
              const openTime    = pos.openedAt
                ? new Date(pos.openedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
                : '—';
              return (
                <div key={pos.id || i} className="pos-child-row">
                  <span className="pos-time">{openTime}</span>
                  <span className="pos-child-qty">{(pos.qty || 0).toLocaleString()}</span>
                  <span>฿{pos.entryPrice?.toFixed(2)}</span>
                  <span>฿{pos.currentPrice?.toFixed(2)}</span>
                  <span className={childPnlUp ? 'pnl-up' : 'pnl-down'}>
                    {childPnlUp ? '+' : ''}฿{Math.round(pos.unrealisedPnL || 0).toLocaleString()}
                  </span>
                  <span className={childPnlUp ? 'pnl-up' : 'pnl-down'}>
                    {childPnlUp ? '+' : ''}{(pos.unrealisedPnLPct || 0).toFixed(2)}%
                  </span>
                  <span className="pos-stop">{pos.stopLoss ? `฿${pos.stopLoss}` : '—'}</span>
                  <span className="pos-tp">{pos.takeProfit ? `฿${pos.takeProfit}` : '—'}</span>
                  <span className="pos-strategy">
                    {pos.strategy && pos.strategy !== 'manual' ? `🤖 ${pos.strategy}` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

---

## IMPLEMENTATION — `dashboard.css`

Append these new classes at the end of the file (do not touch existing classes):

```css
/* ── Phase 7a — Grouped position rows ─────────────────────────────────────── */
.positions-table--grouped {
  display: flex; flex-direction: column; width: 100%;
}
.pos-group {
  border-bottom: 1px solid var(--border);
}
.pos-group-header {
  display: grid;
  grid-template-columns: 100px 110px 110px 90px 110px 80px 28px;
  align-items: center; padding: 8px 10px;
  cursor: pointer; transition: background 0.15s;
  border-left: 2px solid transparent;
}
.pos-group-header:hover { background: var(--bg-hover); }
.pos-group-header--active {
  border-left: 2px solid var(--gold, #f59e0b);
  background: rgba(245,158,11,0.05);
}
.pos-group-sym {
  font-size: 13px; font-weight: 700; color: var(--text-primary);
  display: flex; align-items: center; gap: 6px;
}
.pos-group-count {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent, #3b82f6); color: #fff;
  border-radius: 10px; font-size: 9px; font-weight: 700;
  padding: 1px 6px; min-width: 18px;
}
.pos-group-qty   { font-size: 11px; color: var(--text-muted); }
.pos-group-entry { font-size: 11px; color: var(--text-muted); }
.pos-group-price { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.pos-group-pnl   { font-size: 12px; font-weight: 700; }
.pos-group-pct   { font-size: 11px; font-weight: 600; }
.pos-group-expand {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 9px; padding: 4px;
  justify-self: center;
}
.pos-group-expand:hover { color: var(--text-primary); }

.pos-child-row {
  display: grid;
  grid-template-columns: 50px 70px 90px 90px 100px 75px 75px 75px 1fr;
  align-items: center; padding: 5px 10px 5px 24px;
  font-size: 10px; color: var(--text-muted);
  border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
  background: rgba(0,0,0,0.15);
}
.pos-child-qty { font-weight: 600; color: var(--text-primary); }
```

---

## WHAT NOT TO TOUCH

- Gold tab — no changes
- Portfolio tab — no changes
- All Session view in SET — no changes (keep flat closed rows exactly as is)
- Sell desk — no changes, stays pinned outside scroll zone
- Left watchlist panel — no changes
- Strategy panel, chart, order panel — no changes
- Worker / index.js — no changes

---

## STEP 2 — Write complete replacement files

Write complete files (no patches) for:
- `src/pages/SetMarket.jsx`
- `src/dashboard.css`

Commit: `feat: grouped positions table with expand/collapse and click-to-switch (Phase 7a)`

---

## STEP 3 — Update docs

Update `masterseed.md` (note Phase 7a complete, grouped positions working).
Append to `lessons_learned.md` any new lessons learned.

Commit: `docs: update masterseed and lessons_learned after Phase 7a`

---

## CRITICAL RULES
- Read files fresh from repo before writing (L033, L075)
- Write complete files — never patches (L074)
- executeSellQty for all sells — never executeSell directly
- CSS: src/dashboard.css only — never create a second CSS file
- Sell desk always outside scroll zone, always rendered
