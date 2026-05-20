/**
 * SetMarket.jsx
 * Phase 6 patch — strategyDuration, AI workflow, search, tier filter
 * Phase 6 bottom panel redesign
 *
 * KI011 (Phase 6c) — Per-symbol workflow independence
 * - Props changed: no longer receives flat workflow/orderMode/aiWorkflowActive
 * - Receives: setWorkflows (dict), onSetWorkflowPatch, setOrderModes, onSetOrderModeChange,
 *             onActiveSetSymbolChange
 * - On symbol change: calls onActiveSetSymbolChange(sym) → Dashboard tracks it
 * - Derives per-symbol slice from dict for current activeSymbol
 * - Passes derived slice props down to OrderPanel
 * - aiWorkflowActive is ONLY true when the ACTIVE symbol has a live workflow
 */

import { useState, useCallback, useMemo } from "react";
import ChartPanel    from "../components/ChartPanel.jsx";
import OrderPanel    from "../components/OrderPanel.jsx";
import StrategyPanel from "../components/StrategyPanel.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { useSetMarket } from "../injectors/set-injector.js";
import { useFetchIntel } from "../injectors/intel-injector.js";
import { calcPortfolioSummary, calcHourlyPnL, executeSellQty } from "../core/portfolio-engine.js";
import { makeActivityEvent } from "../components/ActivityLog.jsx";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from "recharts";
import config from "../../config.js";

const WORKER = config.workers.base;

// ── SET/MAI universe ──────────────────────────────────────────────────────────
const SET_UNIVERSE = [
  // ── Top 50 ──────────────────────────────────────────────────────────────
  { t: "PTT.BK",     n: "PTT",                   tier: 1 },
  { t: "AOT.BK",     n: "Airports of Thailand",  tier: 1 },
  { t: "ADVANC.BK",  n: "Advanced Info Service",  tier: 1 },
  { t: "KBANK.BK",   n: "Kasikorn Bank",          tier: 1 },
  { t: "SCB.BK",     n: "SCB (Siam Commercial)",  tier: 1 },
  { t: "BBL.BK",     n: "Bangkok Bank",            tier: 1 },
  { t: "PTTEP.BK",   n: "PTT Exploration & Prod", tier: 1 },
  { t: "GULF.BK",    n: "Gulf Energy Dev",         tier: 1 },
  { t: "TRUE.BK",    n: "True Corporation",        tier: 1 },
  { t: "CPF.BK",     n: "Charoen Pokphand Foods",  tier: 1 },
  { t: "CPALL.BK",   n: "CP All",                  tier: 1 },
  { t: "SCC.BK",     n: "Siam Cement",             tier: 1 },
  { t: "DELTA.BK",   n: "Delta Electronics TH",    tier: 1 },
  { t: "BDMS.BK",    n: "Bangkok Dusit Med",        tier: 1 },
  { t: "BH.BK",      n: "Bumrungrad Hospital",      tier: 1 },
  { t: "INTUCH.BK",  n: "Intouch Holdings",         tier: 1 },
  { t: "HMPRO.BK",   n: "Home Product Center",      tier: 1 },
  { t: "BGRIM.BK",   n: "B.Grimm Power",            tier: 1 },
  { t: "BTS.BK",     n: "BTS Group Holdings",       tier: 1 },
  { t: "IVL.BK",     n: "Indorama Ventures",        tier: 1 },
  { t: "MINT.BK",    n: "Minor International",       tier: 1 },
  { t: "RATCH.BK",   n: "Ratch Group",              tier: 1 },
  { t: "GPSC.BK",    n: "Global Power Synergy",     tier: 1 },
  { t: "TTB.BK",     n: "TMBThanachart Bank",        tier: 1 },
  { t: "TOP.BK",     n: "Thai Oil",                 tier: 1 },
  { t: "PTTGC.BK",   n: "PTT Global Chemical",      tier: 1 },
  { t: "KTB.BK",     n: "Krungthai Bank",           tier: 1 },
  { t: "BAM.BK",     n: "Bangkok Asset Mgmt",       tier: 1 },
  { t: "CPN.BK",     n: "Central Pattana",          tier: 1 },
  { t: "CENTEL.BK",  n: "Central Plaza Hotel",      tier: 1 },
  { t: "MTC.BK",     n: "Muangthai Capital",        tier: 1 },
  { t: "SAWAD.BK",   n: "Sawad Corp",               tier: 1 },
  { t: "AP.BK",      n: "AP Thailand",              tier: 1 },
  { t: "LH.BK",      n: "Land and Houses",          tier: 1 },
  { t: "QH.BK",      n: "Quality Houses",           tier: 1 },
  { t: "TISCO.BK",   n: "TISCO Financial",          tier: 1 },
  { t: "KTC.BK",     n: "Krungthai Card",           tier: 1 },
  { t: "SPRC.BK",    n: "Star Petroleum Refining",  tier: 1 },
  { t: "TU.BK",      n: "Thai Union Group",         tier: 1 },
  { t: "MAKRO.BK",   n: "Makro",                    tier: 1 },
  { t: "OR.BK",      n: "PTT Oil & Retail",         tier: 1 },
  { t: "WHA.BK",     n: "WHA Corporation",          tier: 1 },
  { t: "AMATA.BK",   n: "Amata Corp",               tier: 1 },
  { t: "JMT.BK",     n: "JMT Network Services",     tier: 1 },
  { t: "TIDLOR.BK",  n: "Ngern Tid Lor",            tier: 1 },
  { t: "BJC.BK",     n: "Berli Jucker",             tier: 1 },
  { t: "STGT.BK",    n: "Sri Trang Gloves",         tier: 1 },
  { t: "CBG.BK",     n: "Carabao Group",            tier: 1 },
  { t: "ESSO.BK",    n: "Esso (Thailand)",           tier: 1 },
  { t: "TQM.BK",     n: "TQM Alpha",                tier: 1 },
  // ── Top 100 ─────────────────────────────────────────────────────────────
  { t: "MAJOR.BK",   n: "Major Cineplex",           tier: 2 },
  { t: "CRC.BK",     n: "Central Retail Corp",      tier: 2 },
  { t: "CPAXT.BK",   n: "CP Axtra",                 tier: 2 },
  { t: "ANAN.BK",    n: "Ananda Dev",               tier: 2 },
  { t: "SIRI.BK",    n: "Sansiri",                  tier: 2 },
  { t: "ERW.BK",     n: "Erawan Group",             tier: 2 },
  { t: "SINGER.BK",  n: "Singer Thailand",          tier: 2 },
  { t: "GFPT.BK",    n: "GFPT",                     tier: 2 },
  { t: "SABUY.BK",   n: "Sabuy Technology",         tier: 2 },
  { t: "WARRIX.BK",  n: "Warrix",                   tier: 2 },
  { t: "NOBLE.BK",   n: "Noble Development",        tier: 2 },
  { t: "NVD.BK",     n: "NV Digital",               tier: 2 },
  { t: "ORI.BK",     n: "Origin Property",          tier: 2 },
  { t: "PLANB.BK",   n: "Plan B Media",             tier: 2 },
  { t: "PSL.BK",     n: "Precious Shipping",        tier: 2 },
  { t: "RBF.BK",     n: "Royal Benja Hotel",        tier: 2 },
  { t: "RS.BK",      n: "RS",                       tier: 2 },
  { t: "SAT.BK",     n: "Somboon Advance Tech",     tier: 2 },
  { t: "SC.BK",      n: "SC Asset Corp",            tier: 2 },
  { t: "SCGP.BK",    n: "SCG Packaging",            tier: 2 },
  { t: "SHR.BK",     n: "S Hotels and Resorts",     tier: 2 },
  { t: "SKY.BK",     n: "Sky Thai Airways",         tier: 2 },
  { t: "SPALI.BK",   n: "Supalai",                  tier: 2 },
  { t: "SSP.BK",     n: "Solar Power Solutions",    tier: 2 },
  { t: "ESSO.BK",    n: "ExxonMobil Thailand",      tier: 2 },
  // ── Extended ─────────────────────────────────────────────────────────────
  { t: "AIRA.BK",    n: "AIRA Capital",             tier: 3 },
  { t: "AKP.BK",     n: "Akkhapat Group",           tier: 3 },
  { t: "ALLA.BK",    n: "All Seasons Property",     tier: 3 },
  { t: "ANI.BK",     n: "Asian Nat. Inno",          tier: 3 },
  { t: "AON.BK",     n: "Amorn Print Group",        tier: 3 },
  { t: "APP.BK",     n: "Asia Plus Group",          tier: 3 },
  { t: "ARIP.BK",    n: "AR IP",                    tier: 3 },
  { t: "ASK.BK",     n: "ASK Securities",           tier: 3 },
  { t: "ASN.BK",     n: "Assetwise",                tier: 3 },
  { t: "AUCT.BK",    n: "Auto Auction",             tier: 3 },
  { t: "BA.BK",      n: "Bangkok Airways",          tier: 3 },
  { t: "BAY.BK",     n: "Bank of Ayudhya",          tier: 3 },
  { t: "BBW.BK",     n: "Bangkok Produce",          tier: 3 },
  { t: "BCP.BK",     n: "Bangchak Corp",            tier: 3 },
  { t: "BEAUTY.BK",  n: "Beauty Community",         tier: 3 },
  { t: "BIG.BK",     n: "Big Camera Corp",          tier: 3 },
  { t: "BLA.BK",     n: "Bangkok Life",             tier: 3 },
  { t: "BLAND.BK",   n: "Bangkok Land",             tier: 3 },
  { t: "BR.BK",      n: "Bangkok Ranch",            tier: 3 },
  { t: "BRR.BK",     n: "Bangkok Rubber",           tier: 3 },
  { t: "BROOK.BK",   n: "Brooker Group",            tier: 3 },
  { t: "CCET.BK",    n: "CC&E Textile",             tier: 3 },
  { t: "CEN.BK",     n: "Central Retail (CEN)",     tier: 3 },
  { t: "CFRESH.BK",  n: "Cfresh Industry",          tier: 3 },
  { t: "CHG.BK",     n: "Chularat Hospital",        tier: 3 },
  { t: "CMAN.BK",    n: "Chemical Management",      tier: 3 },
  { t: "CMO.BK",     n: "CMO",                      tier: 3 },
  { t: "COLOR.BK",   n: "Color Image Apparel",      tier: 3 },
  { t: "CRANE.BK",   n: "Crane Heavy Industry",     tier: 3 },
  { t: "CSL.BK",     n: "Country Steel",            tier: 3 },
  { t: "CYBX.BK",    n: "CyberX Technology",        tier: 3 },
  { t: "DCC.BK",     n: "Daiichi Chuo Kisen",       tier: 3 },
  { t: "DIGI.BK",    n: "Digital Telecoms",         tier: 3 },
  { t: "DIMET.BK",   n: "Diamond International",    tier: 3 },
  { t: "DRT.BK",     n: "Diamond Roofing Tiles",    tier: 3 },
  { t: "DTAC.BK",    n: "DTAC",                     tier: 3 },
  { t: "DTC.BK",     n: "Duraking",                 tier: 3 },
  { t: "EARTH.BK",   n: "Earth Tech Environment",   tier: 3 },
  { t: "EC.BK",      n: "Eurocraft",                tier: 3 },
  { t: "EE.BK",      n: "Eastern Electrics",        tier: 3 },
  { t: "EKH.BK",     n: "Ekachai Med Care",         tier: 3 },
  { t: "ETE.BK",     n: "Eastern Tech",             tier: 3 },
  { t: "ETRON.BK",   n: "Etron",                    tier: 3 },
];

// ── Watchlist search + tier filter component ──────────────────────────────────
const TIER_LABELS = { all: "All SET/MAI", "1": "Top 50", "2": "Top 100" };

function WatchlistPanel({ activeSymbol, watchlistData, onSymbolChange }) {
  const [query, setQuery]   = useState("");
  const [tier,  setTier]    = useState("1");

  const filtered = useMemo(() => {
    const tierNum = tier === "all" ? null : parseInt(tier);
    return SET_UNIVERSE.filter(s => {
      if (tierNum && s.tier > tierNum) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return s.t.toLowerCase().includes(q) || s.n.toLowerCase().includes(q);
    }).slice(0, 80);
  }, [query, tier]);

  return (
    <div className="watchlist-panel">
      <div className="section-title">
        SET / MAI
        <TooltipIcon content="Search any SET or MAI listed stock by ticker or name. Filter by market cap tier for quick scalp targets." />
      </div>

      <div className="wl-tier-row">
        {Object.entries(TIER_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={`wl-tier-btn ${tier === key ? "active" : ""}`}
            onClick={() => setTier(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="wl-search-row">
        <input
          type="text"
          className="wl-search-input"
          placeholder="Search ticker or name…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button className="wl-search-clear" onClick={() => setQuery("")}>✕</button>
        )}
      </div>

      <div className="watchlist-list">
        {filtered.length === 0 ? (
          <div className="wl-empty">No results for "{query}"</div>
        ) : (
          filtered.map(s => {
            const quote   = watchlistData[s.t];
            const changeUp = (quote?.changePct || 0) >= 0;
            return (
              <button
                key={s.t}
                className={`watchlist-row ${s.t === activeSymbol ? "active" : ""}`}
                onClick={() => onSymbolChange(s.t)}
              >
                <div className="wl-left">
                  <span className="wl-symbol">{s.t.replace(".BK", "")}</span>
                  <span className="wl-name">{s.n}</span>
                </div>
                <div className="wl-right">
                  {!quote ? (
                    <span className="wl-loading">—</span>
                  ) : (
                    <>
                      <span className="wl-price">฿{quote.price?.toFixed(2)}</span>
                      <span className={`wl-change ${changeUp ? "up" : "down"}`}>
                        {changeUp ? "▲" : "▼"} {Math.abs(quote.changePct || 0).toFixed(2)}%
                      </span>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className="set-market-info">
        <div className="info-item">⏰ Session 1: 10:00–12:30 ICT</div>
        <div className="info-item">⏰ Session 2: 14:30–17:00 ICT</div>
        <div className="info-item">📅 Mon–Fri only</div>
      </div>
    </div>
  );
}

async function logTradeToD1(trade) {
  try {
    await fetch(`${WORKER}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trade),
    });
  } catch (e) {
    console.warn("D1 trade log failed (non-critical):", e.message);
  }
}

// ── Helper: extract one symbol's bundle from the dict ─────────────────────────
function getBundleForSym(setWorkflows, sym) {
  return setWorkflows?.[sym] || {
    workflow: null, stageStatuses: [], activeStageIdx: 0,
    consecutiveRed: 0, workflowDone: false, fallbackTriggered: false, stagePnl: [],
  };
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function SetMarket({
  portfolio,
  setPortfolio,
  enforceHours,
  onAIStrategy,
  activeStrategy,
  onStrategyChange,
  autoExecute,
  onAutoExecuteChange,
  strategyDuration,
  onStrategyDurationChange,
  activityEvents,
  onActivityEvent,
  onLoadMoreLogs,
  logLoading,
  logHasMore,
  // KI011: new dict-based props (replace flat workflow/orderMode props)
  setWorkflows,
  onSetWorkflowPatch,
  setOrderModes,
  onSetOrderModeChange,
  onActiveSetSymbolChange,
}) {
  const [activeSymbol,    setActiveSymbol]    = useState(SET_UNIVERSE[0].t);
  const [timeframe,       setTimeframe]       = useState("1D");
  const [panel3Collapsed, setPanel3Collapsed] = useState(false);
  const [sellQty,         setSellQty]         = useState("");
  const [posView,         setPosView]         = useState("active");
  const [sellDeskOpen,    setSellDeskOpen]    = useState(false);

  const {
    watchlistData, activeQuote, priceHistory, historyLoading,
    loading, error, lastUpdated, marketOpen,
    handleBuy, handleSell,
  } = useSetMarket({ activeSymbol, portfolio, setPortfolio, enforceHours, timeframe });

  const closedTrades = Array.isArray(portfolio?.closedTrades) ? portfolio.closedTrades : [];
  const positions    = Array.isArray(portfolio?.positions)    ? portfolio.positions    : [];
  const hourlyPnL    = calcHourlyPnL(closedTrades.filter(t => t.market === "set"));
  const setPositions = positions.filter(p => p.market === "set");
  const currentPrice = activeQuote?.price || null;

  // All Session D1 fetch
  const [sessionClosed,  setSessionClosed]  = useState([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionLoaded,  setSessionLoaded]  = useState(false);

  async function loadSessionClosed() {
    if (sessionLoading) return;
    setSessionLoading(true);
    try {
      const res  = await fetch(`${WORKER}/api/trades?market=set&side=sell&hours=12&limit=100`);
      const json = await res.json();
      setSessionClosed(json.success ? json.data : []);
      setSessionLoaded(true);
    } catch {
      setSessionClosed([]);
    } finally {
      setSessionLoading(false);
    }
  }

  const fetchIntel = useFetchIntel();

  // KI011: derive active symbol's slice from the dicts
  const symBundle   = getBundleForSym(setWorkflows, activeSymbol);
  const symOrderMode = setOrderModes?.[activeSymbol] || "manual";
  // Only lock if THIS symbol has an active workflow
  const symWorkflowActive = !!symBundle.workflow && !symBundle.workflowDone;

  // Setters that patch only the active symbol's slice
  const setSymWorkflow          = useCallback(v => onSetWorkflowPatch(activeSymbol, { workflow: typeof v === "function" ? v(symBundle.workflow) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.workflow]);
  const setSymStageStatuses     = useCallback(v => onSetWorkflowPatch(activeSymbol, { stageStatuses: typeof v === "function" ? v(symBundle.stageStatuses) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.stageStatuses]);
  const setSymActiveStageIdx    = useCallback(v => onSetWorkflowPatch(activeSymbol, { activeStageIdx: typeof v === "function" ? v(symBundle.activeStageIdx) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.activeStageIdx]);
  const setSymConsecutiveRed    = useCallback(v => onSetWorkflowPatch(activeSymbol, { consecutiveRed: typeof v === "function" ? v(symBundle.consecutiveRed) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.consecutiveRed]);
  const setSymWorkflowDone      = useCallback(v => onSetWorkflowPatch(activeSymbol, { workflowDone: typeof v === "function" ? v(symBundle.workflowDone) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.workflowDone]);
  const setSymFallbackTriggered = useCallback(v => onSetWorkflowPatch(activeSymbol, { fallbackTriggered: typeof v === "function" ? v(symBundle.fallbackTriggered) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.fallbackTriggered]);
  const setSymStagePnl          = useCallback(v => onSetWorkflowPatch(activeSymbol, { stagePnl: typeof v === "function" ? v(symBundle.stagePnl) : v }), [activeSymbol, onSetWorkflowPatch, symBundle.stagePnl]);
  const setSymOrderMode         = useCallback(mode => onSetOrderModeChange(activeSymbol, mode), [activeSymbol, onSetOrderModeChange]);

  // KI011: on symbol change — notify Dashboard, reset timeframe
  const handleSymbolChange = (sym) => {
    setActiveSymbol(sym);
    setTimeframe("1D");
    onActiveSetSymbolChange?.(sym);
  };

  function pushEvent(params) {
    onActivityEvent?.(makeActivityEvent({ market: "set", ...params }));
  }

  const handleStrategyBuy = useCallback(async (order) => {
    const result = await handleBuy(order);
    if (result?.error) {
      pushEvent({ type: "block", symbol: order.symbol, detail: `Rejected: ${result.error}` });
      return result;
    }
    if (result?.trade) {
      pushEvent({ type: "buy", symbol: order.symbol, price: order.price, detail: `${order.strategy || activeStrategy} × ${order.qty}` });
      logTradeToD1({ id: result.trade.id, symbol: order.symbol, market: "set", side: "buy", qty: order.qty, entry_price: order.price, exit_price: null, pnl: null, strategy: order.strategy || activeStrategy, opened_at: new Date().toISOString(), closed_at: null, sim_mode: 1 });
    }
    return result;
  }, [handleBuy, activeStrategy]);

  const handleStrategySell = useCallback(async (positionId, price) => {
    const setPos   = (portfolio?.positions || []).filter(p => p.market === "set" && p.symbol === activeSymbol);
    const totalQty = setPos.reduce((s, p) => s + p.qty, 0);
    if (totalQty === 0) return;
    const result = executeSellQty(portfolio, "set", activeSymbol, totalQty, price || currentPrice);
    if (result.error) {
      pushEvent({ type: "block", symbol: activeSymbol, detail: `Strategy sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({ type: "sell", symbol: activeSymbol, price: price || currentPrice, detail: `Strategy sold ${totalQty} shares FIFO | Avg entry ฿${result.avgEntryPrice?.toFixed(2)} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`, pnl: result.totalPnl });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "set", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price || currentPrice, pnl: t.pnl, strategy: t.strategy || activeStrategy, opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
    setSessionLoaded(false);
  }, [portfolio, currentPrice, activeSymbol, activeStrategy]);

  function handleSellDesk() {
    const qty   = parseFloat(sellQty);
    if (!qty || qty <= 0) return;
    const price = currentPrice;
    if (!price) return;
    const result = executeSellQty(portfolio, "set", activeSymbol, qty, price);
    if (result.error) {
      pushEvent({ type: "block", symbol: activeSymbol, detail: `Sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({ type: "sell", symbol: activeSymbol, price, detail: `Sold ${qty} shares FIFO @ ฿${price?.toFixed(2)} | Avg entry ฿${result.avgEntryPrice?.toFixed(2)} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`, pnl: result.totalPnl });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "set", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price, pnl: t.pnl, strategy: t.strategy || "manual", opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
    setSellQty("");
    setSellDeskOpen(false);
    setSessionLoaded(false);
  }

  function handleStrategyEvent(ev) {
    pushEvent({ ...ev, symbol: activeSymbol });
  }

  return (
    <div className="market-page set-market">

      {/* ── Ticker Header ── */}
      <div className="ticker-header">
        <div className="set-header-left">
          <span className="set-market-title">📈 SET / MAI</span>
          <span className="set-delayed-badge">
            ⚠ 15-min delayed
            <Tooltip content="SET data is provided by Yahoo Finance on a 15-minute delay.">
              <span className="delayed-info">ⓘ</span>
            </Tooltip>
          </span>
        </div>

        <div className="price-display">
          {loading ? (
            <span className="price-loading">Loading SET data...</span>
          ) : error ? (
            <span className="price-error">⚠ {error}</span>
          ) : activeQuote ? (
            <>
              <span className="set-active-symbol">{activeSymbol.replace(".BK", "")}</span>
              <span className="price-main">฿{activeQuote.price?.toFixed(2)}</span>
              <span className={`set-change ${activeQuote.changePct >= 0 ? "pnl-up" : "pnl-down"}`}>
                {activeQuote.changePct >= 0 ? "▲" : "▼"} {Math.abs(activeQuote.changePct || 0).toFixed(2)}%
              </span>
            </>
          ) : null}
        </div>

        <div className="ticker-meta">
          {activeQuote && (
            <>
              <span className="meta-item">O: <strong>฿{activeQuote.open?.toFixed(2)}</strong></span>
              <span className="meta-item">H: <strong style={{color:"#22c55e"}}>฿{activeQuote.high?.toFixed(2)}</strong></span>
              <span className="meta-item">L: <strong style={{color:"#ef4444"}}>฿{activeQuote.low?.toFixed(2)}</strong></span>
              <span className="meta-item">Vol: <strong>{(activeQuote.volume/1000000).toFixed(1)}M</strong></span>
              <span className="meta-item">Updated: <strong>{lastUpdated?.toLocaleTimeString()}</strong></span>
            </>
          )}
        </div>
      </div>

      {/* ── Main Body ── */}
      <div className="market-body">

        {/* Watchlist */}
        <div className="panel-watchlist">
          <WatchlistPanel
            activeSymbol={activeSymbol}
            watchlistData={watchlistData}
            onSymbolChange={handleSymbolChange}
          />
        </div>

        {/* Left column */}
        <div className="panel-left">

          <div className="panel-chart">
            <ChartPanel
              data={priceHistory}
              symbol={activeSymbol}
              market="set"
              timeframe={timeframe}
              historyLoading={historyLoading}
              onTimeframeChange={setTimeframe}
              onIntelRequest={(symbol, date) => fetchIntel(symbol, date, "set")}
            />

            {hourlyPnL.length > 0 && (
              <div className="hourly-pnl">
                <div className="section-title">
                  Hourly P&L — SET
                  <TooltipIcon content="Profit or loss from SET trades by hour." />
                </div>
                <ResponsiveContainer width="100%" height={80}>
                  <BarChart data={hourlyPnL} margin={{ top:4, right:8, left:8, bottom:0 }}>
                    <XAxis dataKey="hour" tick={{fill:"#9ca3af",fontSize:10}} tickLine={false} />
                    <YAxis hide domain={["auto","auto"]} />
                    <Bar dataKey="pnl" radius={[2,2,0,0]} isAnimationActive={false}>
                      {hourlyPnL.map((e,i) => <Cell key={i} fill={e.pnl>=0?"#22c55e":"#ef4444"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="market-info-bar" style={{ padding: 0, border: "none" }}>
              <Tooltip content="SET data is 15 minutes delayed via Yahoo Finance.">
                <span className="info-item">⚠ Prices 15-min delayed</span>
              </Tooltip>
              <Tooltip content="Commission: 0.157% of trade value (min ฿50) + 7% VAT + 0.1% transfer fee on sell.">
                <span className="info-item">💸 Commission: 0.157% + VAT + 0.1% transfer</span>
              </Tooltip>
              <Tooltip content="SET minimum order is 1 lot = 100 shares.">
                <span className="info-item">📦 Min: 1 lot = 100 shares</span>
              </Tooltip>
            </div>
          </div>

          {/* Panel Bottom */}
          <div className={`panel-bottom ${panel3Collapsed ? "collapsed" : ""}`}>
            <div className="panel3-header">
              <span className="panel3-title">
                Positions ({setPositions.length})
                {posView === "all" && sessionClosed.length > 0 && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {sessionClosed.length} closed this session</span>
                )}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="pos-view-toggle">
                  <button
                    className={`pos-view-btn ${posView === "active" ? "active" : ""}`}
                    onClick={() => setPosView("active")}
                  >Active</button>
                  <button
                    className={`pos-view-btn ${posView === "all" ? "active" : ""}`}
                    onClick={() => { setPosView("all"); loadSessionClosed(); }}
                  >All Session</button>
                </div>
                <button className="panel3-collapse-btn" onClick={() => setPanel3Collapsed(v => !v)}>
                  {panel3Collapsed ? "▲ Show" : "▼ Hide"}
                </button>
              </div>
            </div>

            {!panel3Collapsed && (
              <div className="panel-bottom-body panel-bottom-body--single">

                {/* Scrollable positions zone */}
                <div className="panel-bottom-zone positions-zone pz-unified">
                  {(() => {
                    const openRows   = setPositions.map(pos => ({ ...pos, _rowType: "open" }));
                    const closedRows = posView === "all"
                      ? sessionClosed.map(t => ({ ...t, _rowType: "closed" }))
                      : [];
                    const allRows = [...openRows, ...closedRows];

                    if (posView === "all" && sessionLoading) {
                      return <div className="empty-state">⏳ Loading last 12 hours...</div>;
                    }
                    if (allRows.length === 0) {
                      return (
                        <div className="empty-state">
                          {posView === "active" ? "No open positions. Select a stock and place a buy order." : "No trades in the last 12 hours."}
                        </div>
                      );
                    }
                    return (
                      <div className="positions-table positions-table--12col">
                        <div className="pos-row pos-row--12col header">
                          <span>Time</span><span>Side</span><span>Symbol</span><span>Qty</span>
                          <span>Entry</span><span>Price</span><span>P&L</span><span>P&L%</span>
                          <span>Stop</span><span>Target</span><span>Strategy</span><span>Status</span>
                        </div>
                        {allRows.map((row, i) => {
                          if (row._rowType === "open") {
                            const pnlUp = row.unrealisedPnL >= 0;
                            const openTime = row.openedAt ? new Date(row.openedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
                            return (
                              <div key={row.id || i} className="pos-row pos-row--12col">
                                <span className="pos-time">{openTime}</span>
                                <span className="pos-side pos-side--buy">▲ BUY</span>
                                <span className="pos-symbol">{row.symbol?.replace(".BK","")}</span>
                                <span>{row.qty?.toLocaleString()}</span>
                                <span>฿{row.entryPrice?.toFixed(2)}</span>
                                <span>฿{row.currentPrice?.toFixed(2)}</span>
                                <span className={pnlUp?"pnl-up":"pnl-down"}>{pnlUp?"+":""}฿{row.unrealisedPnL?.toLocaleString("en-US",{minimumFractionDigits:0})}</span>
                                <span className={pnlUp?"pnl-up":"pnl-down"}>{pnlUp?"+":""}{row.unrealisedPnLPct?.toFixed(2)}%</span>
                                <span className="pos-stop">{row.stopLoss   ? `฿${row.stopLoss}`   : "—"}</span>
                                <span className="pos-tp">  {row.takeProfit ? `฿${row.takeProfit}` : "—"}</span>
                                <span className="pos-strategy">{row.strategy !== "manual" ? `🤖 ${row.strategy}` : "—"}</span>
                                <span className="pos-status pos-status--active">ACTIVE</span>
                              </div>
                            );
                          } else {
                            const pnlUp = (row.pnl ?? 0) >= 0;
                            const closeTime = row.closed_at ? new Date(row.closed_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
                            return (
                              <div key={row.id || i} className="pos-row pos-row--12col pos-row--closed">
                                <span className="pos-time">{closeTime}</span>
                                <span className="pos-side pos-side--sell">▼ SELL</span>
                                <span className="pos-symbol">{row.symbol?.replace(".BK","")}</span>
                                <span>{row.qty?.toLocaleString()}</span>
                                <span>฿{parseFloat(row.entry_price)?.toFixed(2)}</span>
                                <span>{row.exit_price ? `฿${parseFloat(row.exit_price)?.toFixed(2)}` : "—"}</span>
                                <span className={pnlUp?"pnl-up":"pnl-down"}>
                                  {row.pnl != null ? `${pnlUp?"+":""}฿${Math.round(row.pnl)?.toLocaleString()}` : "—"}
                                </span>
                                <span>—</span><span>—</span><span>—</span>
                                <span className="pos-strategy">{row.strategy !== "manual" ? `🤖 ${row.strategy}` : "—"}</span>
                                <span className="pos-status pos-status--closed">CLOSED</span>
                              </div>
                            );
                          }
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* Sell Desk — pinned, never inside scroll zone */}
                {(() => {
                  const symPos    = setPositions.filter(p => p.symbol === activeSymbol);
                  const totalHeld = symPos.reduce((s, p) => s + p.qty, 0);
                  const totalCost = symPos.reduce((s, p) => s + p.totalCost, 0);
                  const avgEntry  = totalHeld > 0 ? totalCost / totalHeld : 0;
                  const price     = currentPrice || 0;
                  const totalPnl  = symPos.reduce((s, p) => s + p.unrealisedPnL, 0);
                  const sellN     = parseFloat(sellQty) || 0;
                  const estPnl    = sellN > 0 ? (price - avgEntry) * sellN : null;
                  const pnlUp     = (estPnl ?? 0) >= 0;
                  const pnlColor  = totalPnl >= 0 ? "pnl-up" : "pnl-down";
                  return (
                    <div className="sell-desk sell-desk--collapsible sell-desk--pinned">
                      <button
                        className="sell-desk-summary-line"
                        onClick={() => setSellDeskOpen(v => !v)}
                      >
                        <span className="sdsl-symbol">{activeSymbol?.replace(".BK","")}</span>
                        <span className="sdsl-sep">—</span>
                        <span className="sdsl-qty"><strong>{totalHeld?.toLocaleString()}</strong> shares</span>
                        <span className="sdsl-sep">|</span>
                        <span className="sdsl-avg">Avg ฿{totalHeld > 0 ? avgEntry?.toFixed(2) : "—"}</span>
                        <span className="sdsl-sep">|</span>
                        <span className={`sdsl-pnl ${pnlColor}`}>
                          P&L: {totalPnl >= 0 ? "+" : ""}฿{Math.round(totalPnl)?.toLocaleString()}
                        </span>
                        <span className="sdsl-cta">{sellDeskOpen ? "▲ Close" : "▼ Sell"}</span>
                      </button>
                      {sellDeskOpen && (
                        <div className="sell-desk-body">
                          {totalHeld === 0 ? (
                            <div className="empty-state" style={{ fontSize: "11px", padding: "4px 0" }}>
                              Switch to the active symbol to sell.
                            </div>
                          ) : (
                            <>
                              <div className="sell-desk-controls">
                                <input
                                  type="number"
                                  className="sell-desk-input"
                                  value={sellQty}
                                  onChange={e => setSellQty(e.target.value)}
                                  placeholder={`Qty (max ${totalHeld?.toLocaleString()})`}
                                  min={100} max={totalHeld} step={100}
                                />
                                <button className="sell-desk-all-btn"  onClick={() => setSellQty(String(totalHeld))}>All</button>
                                <button className="sell-desk-half-btn" onClick={() => setSellQty(String(Math.floor(totalHeld / 200) * 100 || 100))}>Half</button>
                              </div>
                              {estPnl !== null && (
                                <div className={`sell-desk-preview ${pnlUp ? "pnl-up" : "pnl-down"}`}>
                                  Sell {sellN?.toLocaleString()} shares → Est. {pnlUp ? "profit" : "loss"}: {pnlUp ? "+" : ""}฿{Math.round(estPnl)?.toLocaleString()}
                                </div>
                              )}
                              <button
                                className="sell-desk-btn"
                                onClick={handleSellDesk}
                                disabled={!sellQty || parseFloat(sellQty) <= 0 || parseFloat(sellQty) > totalHeld}
                              >
                                ▼ SELL {sellQty ? parseInt(sellQty)?.toLocaleString() : "?"} SHARES @ MARKET
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Activity log placeholder */}
                <div className="activity-log-placeholder">
                  📋 Activity log available in D1 Panel (coming soon)
                </div>

              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="panel-controls">
          {/* KI011: pass derived per-symbol props to OrderPanel */}
          <OrderPanel
            market="set"
            currentPrice={currentPrice}
            portfolio={portfolio}
            onBuy={handleBuy}
            onSell={handleSell}
            marketOpen={marketOpen}
            enforceHours={enforceHours}
            onAIStrategy={onAIStrategy}
            orderMode={symOrderMode}
            onOrderModeChange={setSymOrderMode}
            recentCloses={priceHistory.slice(-10).map(c => c.close).filter(Boolean)}
            selectedSymbol={activeSymbol}
            onLogActivity={onActivityEvent}
            aiWorkflowActive={symWorkflowActive}
            workflowSymbol={symBundle.workflow?.symbol || null}
            workflow={symBundle.workflow}          setWorkflow={setSymWorkflow}
            stageStatuses={symBundle.stageStatuses} setStageStatuses={setSymStageStatuses}
            activeStageIdx={symBundle.activeStageIdx} setActiveStageIdx={setSymActiveStageIdx}
            consecutiveRed={symBundle.consecutiveRed} setConsecutiveRed={setSymConsecutiveRed}
            workflowDone={symBundle.workflowDone}   setWorkflowDone={setSymWorkflowDone}
            fallbackTriggered={symBundle.fallbackTriggered} setFallbackTriggered={setSymFallbackTriggered}
            stagePnl={symBundle.stagePnl}           setStagePnl={setSymStagePnl}
          />

          {symOrderMode === "manual" && (
            <StrategyPanel
              market="set"
              symbol={activeSymbol}
              priceHistory={priceHistory}
              currentPrice={currentPrice}
              portfolio={portfolio}
              activeStrategy={activeStrategy}
              onStrategyChange={onStrategyChange}
              autoExecute={autoExecute}
              onAutoExecuteChange={onAutoExecuteChange}
              strategyDuration={strategyDuration}
              onStrategyDurationChange={onStrategyDurationChange}
              onExecuteBuy={handleStrategyBuy}
              onExecuteSell={handleStrategySell}
              onStrategyEvent={handleStrategyEvent}
              aiWorkflowActive={symWorkflowActive}
            />
          )}
        </div>
      </div>
    </div>
  );
}
