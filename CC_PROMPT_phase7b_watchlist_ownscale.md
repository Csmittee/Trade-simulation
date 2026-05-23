# CC PROMPT — Phase 7b: Per-Lane Own Scale + Curated Watchlist
# Run AFTER Phase 7a is confirmed working
# Paste this entire block into Claude Code

---

## STEP 1 — Read context first (mandatory)
Read `masterseed.md` and `lessons_learned.md` from repo root before anything else.

Then read these files fresh from the repo:
- `src/injectors/portfolio-injector.js`
- `src/pages/Portfolio.jsx`
- `src/pages/SetMarket.jsx`
- `src/pages/Dashboard.jsx`
- `src/dashboard.css`

Do NOT assume content matches previous sessions. Read fresh (L033, L075).

---

## CHANGE A — Per-lane independent own scale
### Files: `portfolio-injector.js` + `Portfolio.jsx`

### Problem
`computeSharedOwnRuler` puts all lanes on one shared time axis (earliest open → latest end across ALL lanes). GULF's 3-day workflow and Gold's 4-hour strategy both sit on the same ruler — a short-duration lane looks tiny compared to a long one. The "now dot" is meaningless because it's relative to the shared span not each lane's own plan.

### What it should do
In "own scale" mode each lane bar is ALWAYS full width (0%→100%) of its own track. The now-dot position = `(now - laneOpen) / (laneEnd - laneOpen)` for THAT lane only. Each lane shows its own mini time ruler below its bar. Shared clock mode is completely unchanged.

### `portfolio-injector.js` — add new exported function

Add `computePerLaneScale(lane)` after `computeSharedOwnRuler`:

```js
// ── Per-lane independent scale (own scale mode) ───────────────────────────────
// Each lane fills 100% of its own bar. Now-dot and stage nodes are
// positioned relative to that lane's own open→end span only.

export function computePerLaneScale(lane) {
  const now    = Date.now();
  const openMs = lane.ownScaleOpenMs || now;
  const endMs  = lane.ownScaleEndMs  || (now + 4 * 3600 * 1000);
  const spanMs = Math.max(1, endMs - openMs);

  // Now dot: 0=start edge, 1=end edge, clamped
  lane.perLaneNowPct    = Math.min(1, Math.max(0, (now - openMs) / spanMs));
  lane.perLaneNowInSpan = now >= openMs && now <= endMs;

  // Reposition stage nodes within this lane's own span
  if (lane.stageNodes?.length) {
    lane.stageNodes = lane.stageNodes.map(node => ({
      ...node,
      pct: node.endMs != null
        ? Math.min(100, Math.max(0, Math.round(((node.endMs - openMs) / spanMs) * 100)))
        : null,
    }));
  }

  // Mini ruler: 5 ticks from open to end
  const sameDay = spanMs < 24 * 3600 * 1000;
  lane.perLaneRuler = Array.from({ length: 5 }, (_, i) => {
    const pct   = i / 4;
    const ms    = openMs + pct * spanMs;
    const d     = new Date(ms);
    const label = sameDay
      ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Bangkok' });
    return { pct: Math.round(pct * 100), label };
  });

  return lane;
}
```

Keep `computeSharedOwnRuler` exactly as is — it is still used for shared clock mode.

### `Portfolio.jsx` changes

1. Import `computePerLaneScale` alongside existing imports from portfolio-injector.

2. In the `own` scale mode, call `computePerLaneScale(lane)` on each lane before rendering:
```js
const visibleLanesOwn = scaleMode === 'own'
  ? visibleLanes.map(lane => computePerLaneScale({ ...lane }))
  : visibleLanes;
```
Use `visibleLanesOwn` when rendering in own scale mode.

3. The shared ruler row (`<div className="bf2-timeline-ruler">`) renders ONLY in shared clock mode. In own scale mode remove it — each lane has its own ruler below.

4. In the own scale lane renderer:
   - Bar is always: `left: 0%, width: 100%` (full width always)
   - Now dot uses `lane.perLaneNowPct` (not `lane.ownScaleNowPct`)
   - Now dot color uses `lane.perLaneNowInSpan`
   - After the `bf2-lane-track` div, add the mini ruler:

```jsx
{scaleMode === 'own' && (
  <div className="bf2-per-lane-ruler">
    {(lane.perLaneRuler || []).map((tick, i) => (
      <span key={i} className="bf2-per-lane-tick" style={{ left: `${tick.pct}%` }}>
        {tick.label}
      </span>
    ))}
  </div>
)}
```

---

## CHANGE B — Curated watchlist (hidden by default, KV-persisted)
### Files: `Dashboard.jsx` + `SetMarket.jsx` + `dashboard.css`

### `Dashboard.jsx` changes

**1. Add userWatchlist state** (near other useState declarations):
```js
const [userWatchlist, setUserWatchlist] = useState(
  config.data.set.watchlistDefault ||
  ['PTT.BK','AOT.BK','ADVANC.BK','KBANK.BK','SCB.BK','CPF.BK','TRUE.BK','GULF.BK']
);
```

**2. Restore from KV** — inside the `if (savedBundle && savedBundle !== "null")` block, after existing restores:
```js
if (Array.isArray(b.userWatchlist) && b.userWatchlist.length > 0) {
  setUserWatchlist(b.userWatchlist);
}
```

**3. Add to KV save bundle** — inside the `kvSetSetting(BUNDLE_KEY, JSON.stringify({...}))` call, add:
```js
userWatchlist,
```
And add `userWatchlist` to the `useEffect` dependency array for that persist effect.

**4. Add handlers** (near other handlers):
```js
const handleAddToWatchlist = useCallback(sym =>
  setUserWatchlist(prev => prev.includes(sym) ? prev : [...prev, sym]), []);

const handleRemoveFromWatchlist = useCallback(sym =>
  setUserWatchlist(prev => prev.filter(s => s !== sym)), []);
```

**5. Pass to SetMarket** in `setMarketProps`:
```js
userWatchlist,
onAddToWatchlist:       handleAddToWatchlist,
onRemoveFromWatchlist:  handleRemoveFromWatchlist,
```

### `SetMarket.jsx` changes

**1. watchlistCollapsed starts true:**
Change `useState(false)` → `useState(true)` for `watchlistCollapsed`.

**2. Destructure new props:**
Add `userWatchlist`, `onAddToWatchlist`, `onRemoveFromWatchlist` to the SetMarket props destructuring.

**3. Pass new props to WatchlistPanel** in the JSX:
```jsx
<WatchlistPanel
  activeSymbol={activeSymbol}
  watchlistData={watchlistData}
  onSymbolChange={handleSymbolChange}
  userWatchlist={userWatchlist}
  onAddToWatchlist={onAddToWatchlist}
  onRemoveFromWatchlist={onRemoveFromWatchlist}
/>
```

**4. Rewrite WatchlistPanel component** — add the new props to its signature, then restructure its render:

**Top section — pinned watchlist:**
- Label: "★ My Watchlist"
- For each sym in `userWatchlist`: show a row with the symbol's price/change data (look up from `watchlistData[sym]`), a click handler `onSymbolChange(sym)`, and a ✕ remove button calling `onRemoveFromWatchlist(sym)`
- If watchlist is empty: show "Add symbols below ☆"

**Divider then Browse section:**
- Label: "Browse SET/MAI"
- Existing tier filter buttons (unchanged)
- Existing search input (unchanged)
- Symbol list rows: same as today BUT each row also has a ☆/★ button on the right:
  - If `userWatchlist.includes(s.t)`: show filled ★, disabled, gold color
  - Else: show ☆, clicking calls `onAddToWatchlist(s.t)` (stopPropagation)
  - Clicking the main row still calls `onSymbolChange(s.t)` as before

The session hours info block at the bottom stays.

---

## CSS additions — append to end of `dashboard.css`

```css
/* ── Phase 7b — Per-lane own scale ruler ──────────────────────────────────── */
.bf2-per-lane-ruler {
  position: relative; height: 14px; margin-top: 2px; margin-bottom: 4px;
}
.bf2-per-lane-tick {
  position: absolute; transform: translateX(-50%);
  font-size: 8px; color: var(--text-muted); white-space: nowrap; pointer-events: none;
}

/* ── Phase 7b — Curated watchlist ─────────────────────────────────────────── */
.wl-section-label {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.6px; color: var(--text-muted); padding: 6px 0 3px;
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.wl-pinned-row {
  display: flex; align-items: center; gap: 2px;
  border-radius: 4px; margin-bottom: 1px;
}
.wl-pinned-row:hover { background: var(--bg-hover); }
.wl-pinned-main {
  flex: 1; display: flex; justify-content: space-between; align-items: center;
  background: none; border: none; cursor: pointer; padding: 4px 6px;
  border-radius: 4px; text-align: left;
}
.wl-remove-btn {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 10px; padding: 4px 6px; opacity: 0.4; flex-shrink: 0;
}
.wl-remove-btn:hover { opacity: 1; color: var(--red, #ef4444); }
.wl-add-btn {
  background: none; border: none; cursor: pointer;
  font-size: 14px; padding: 0 5px; line-height: 1; color: var(--text-muted);
  flex-shrink: 0;
}
.wl-add-btn:hover:not(:disabled) { color: var(--gold, #f59e0b); }
.wl-add-btn:disabled { color: var(--gold, #f59e0b); cursor: default; }
.wl-browse-row {
  display: flex; align-items: center;
}
.wl-browse-main {
  flex: 1;
}
```

---

## WHAT NOT TO TOUCH

- Gold tab — no changes
- Portfolio shared clock mode — no changes to `computeSharedOwnRuler`
- SET positions grouped table (Phase 7a) — no changes
- Sell desk — no changes
- Strategy panel, order panel — no changes
- Worker / index.js — no changes

---

## STEP 2 — Write complete replacement files

Write complete files (no patches) for:
- `src/injectors/portfolio-injector.js`
- `src/pages/Portfolio.jsx`
- `src/pages/SetMarket.jsx`
- `src/pages/Dashboard.jsx`
- `src/dashboard.css`

Commit: `feat: per-lane own scale + curated KV watchlist (Phase 7b)`

---

## STEP 3 — Update docs

Update `masterseed.md` (Phase 7b complete, note own scale per-lane and watchlist features).
Append new lessons to `lessons_learned.md`.

Commit: `docs: update masterseed and lessons_learned after Phase 7b`

---

## CRITICAL RULES
- Read files fresh from repo before writing (L033, L075)
- Write complete files — never patches (L074)
- Any if/else chain edit: show entire chain in one block (L076)
- Duration = MINUTES integer, parseDurationMs(n) = n*60*1000 (L073)
- executeSellQty for all sells — never executeSell directly
- CSS: src/dashboard.css only — never create a second CSS file
- Sell desk always outside scroll zone, always rendered
- Three-point prop chain (L054): userWatchlist + handlers in Dashboard state → setMarketProps → SetMarket destructure
- userWatchlist must be added to KV bundle JSON AND the persist useEffect dependency array
