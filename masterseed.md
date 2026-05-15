# 🌱 MASTERSEED — Thai Trading Simulator
> Resume any new chat from this file. It contains all decisions, current phase, and next steps.

---

## PROJECT IDENTITY
- **Name:** Thai Trading Simulator (TTS)
- **Purpose:** Paper trading learning ground — Thai SET/MAI stocks + Thai Gold (XAUUSD/Baht)
- **Owner:** Single user, no auth required
- **Last Updated:** Phase 0 — Blueprint complete, no code written yet

---

## STACK (LOCKED)

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Tailwind + Recharts | Cloudflare Pages, deploy from GitHub |
| Workers | Cloudflare Workers | API gateway, protects all keys |
| Live State | Cloudflare KV | Portfolio state, intel cache (24hr) |
| History | Cloudflare D1 | Trade log, P&L records, strategy log |
| AI | Anthropic API (claude-sonnet-4-20250514) | Via Worker only, never browser-direct |
| SET Data | Yahoo Finance proxy (15-min delay) | Free tier, Worker-proxied |
| Gold Data | metals.live + Thai gold scrape | Free, Worker-proxied |

---

## FEATURE DECISIONS (LOCKED)

| Feature | Decision |
|---|---|
| Markets at launch | SET/MAI + Gold (Thai Baht + XAUUSD) |
| Crypto | Phase 6+ (not in scope yet) |
| Users | Single user, no login |
| Market hours | Toggle ON/OFF on dashboard header |
| Balance | User-set on first load + Reset button (game restart) |
| Analytics depth | Mid: candlestick + MA overlay + basic risk metrics |
| Strategy modes | Manual / Preset Tactics / AI Assist |
| Tooltip bubbles | English, on every button and panel |
| Insider Intel | Hover 1.5s → AI fetch with web search, 24hr KV cache, manual override |
| Intel language | English only |
| Token strategy | On-demand only, 150 token cap, cache-first |

---

## FOLDER STRUCTURE

```
/
├── src/
│   ├── pages/
│   │   ├── Dashboard.jsx         ← master layout + header
│   │   ├── SetMarket.jsx         ← Thai stocks tab
│   │   ├── GoldMarket.jsx        ← Gold tab
│   │   └── Portfolio.jsx         ← combined portfolio view
│   ├── injectors/
│   │   ├── set-injector.js       ← SET data fetch + trade logic
│   │   ├── gold-injector.js      ← Gold data fetch + trade logic
│   │   └── strategy-injector.js  ← all 3 strategy mode logic
│   ├── core/
│   │   ├── sim-engine.js         ← market hours toggle, price simulation
│   │   ├── portfolio-engine.js   ← P&L, position sizing, risk calc
│   │   └── ai-client.js          ← calls Worker (never Anthropic directly)
│   ├── components/
│   │   ├── Tooltip.jsx           ← bubble assist system
│   │   ├── InsiderIntel.jsx      ← hover intel overlay
│   │   ├── OrderPanel.jsx        ← buy/sell + strategy selector
│   │   ├── ChartPanel.jsx        ← candlestick + MA
│   │   ├── RiskMeter.jsx         ← risk display
│   │   └── TradeLog.jsx          ← today's executions
│   └── config.js                 ← all endpoints, KV IDs, model names
├── workers/
│   ├── ai-strategy/              ← Anthropic + web search
│   ├── set-proxy/                ← Yahoo Finance fetch
│   └── gold-proxy/               ← metals.live + Thai gold
├── masterseed.md                 ← THIS FILE
└── lessons_learned.md            ← coding gotchas log
```

---

## BUILD PHASES

| Phase | Scope | Status |
|---|---|---|
| 0 | Blueprint + docs | ✅ COMPLETE |
| 1 | Gold tab + live data + manual trading + KV state + basic chart | ✅ COMPLETE |
| 2 | SET tab + Yahoo Finance Worker + market hours toggle | ⬜ NOT STARTED |
| 3 | Preset strategy tactics + auto-execution sim + D1 logging | ⬜ NOT STARTED |
| 4 | AI Assist Worker + prompt panel + insider intel hover | ⬜ NOT STARTED |
| 5 | Full analytics: hourly P&L, drawdown, win rate, portfolio chart | ⬜ NOT STARTED |
| 6 | Bitcoin/Crypto (future) | ⬜ BACKLOG |

---

## PHASE 1 — NEXT STEPS (start here)

1. Create `config.js` with all placeholder endpoints
2. Build `gold-proxy` Cloudflare Worker (metals.live + Thai gold)
3. Build `GoldMarket.jsx` with candlestick chart + order panel
4. Build `portfolio-engine.js` — balance set/reset, P&L calc
5. Wire KV for portfolio state persistence
6. Add `Tooltip.jsx` bubble system across all buttons

### Phase 1 Files to Create (in order):
- [ ] `config.js`
- [ ] `workers/gold-proxy/index.js`
- [ ] `src/core/portfolio-engine.js`
- [ ] `src/components/Tooltip.jsx`
- [ ] `src/components/ChartPanel.jsx`
- [ ] `src/components/OrderPanel.jsx`
- [ ] `src/pages/GoldMarket.jsx`
- [ ] `src/pages/Dashboard.jsx` (shell only in Phase 1)

---

## KEY CONTEXT TO ALWAYS REMEMBER

- **No local dev environment** — all code deployed via GitHub → Cloudflare Pages
- **Worker base URL:** `https://tts-workers.csmittee.workers.dev` — never change this
- **Single user** — KV keys are flat (no user prefix needed)
- **Market hours toggle** is a runtime switch stored in KV, not hardcoded
- **Insider Intel** calls Anthropic Worker only on hover >1.5s AND cache miss
- **AI model:** always `claude-sonnet-4-20250514` — do not change without updating this file
- **Balance reset** wipes KV portfolio state and resets to user-defined starting amount
- **SET data** is 15-min delayed via Yahoo Finance — acceptable for sim, note this in UI
- **Thai Gold price** = XAUUSD × THB/USD rate × (96.5% purity conversion for baht gold)

---

## ENVIRONMENT VARIABLES (to be set in Cloudflare dashboard)

```
ANTHROPIC_API_KEY=        ← your key, set in Worker env, never in frontend
METALS_LIVE_KEY=          ← free tier key from metals.live
KV_NAMESPACE_ID=          ← set after creating KV namespace
D1_DATABASE_ID=           ← set after creating D1 database
```

---

## AIRTABLE NOTE
Airtable is available but not used in core architecture. Potential use: export trade history to Airtable for external analysis if needed in future phases.
