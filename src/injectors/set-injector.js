/**
 * set-injector.js
 * All SET/MAI market data fetching and trade wiring.
 * Used by SetMarket.jsx — isolated from gold logic (L006).
 *
 * Phase 2 scope:
 * - Watchlist of 8 default stocks, user can switch between them
 * - Live ticks only (no historical candles for SET in Phase 2)
 * - 15-min delayed data via Yahoo Finance Worker proxy (L002)
 * - Same buy/sell/SL/TP mechanics as gold
 * - SET commission: 0.157% + VAT + 0.1% transfer fee (baked into portfolio-engine)
 * - Minimum lot size: 100 shares
 */

import { useState, useEffect, useRef, useCallback } from "react";
import config from "../../config.js";
import { executeBuy, executeSell, updatePositionPrices, isMarketOpen } from "../core/portfolio-engine.js";

const WORKER_SET   = config.workers.base + config.workers.routes.set;
const REFRESH_MS   = config.data.set.refreshIntervalMs;
const WATCHLIST    = config.data.set.watchlistDefault;

/**
 * useSetMarket — custom hook for all SET market state.
 * Returns everything SetMarket.jsx needs.
 *
 * @param {string}   activeSymbol  — currently selected stock e.g. "PTT.BK"
 * @param {object}   portfolio     — current portfolio state
 * @param {function} setPortfolio  — state setter from Dashboard
 * @param {boolean}  enforceHours  — from dashboard toggle
 */
export function useSetMarket({ activeSymbol, portfolio, setPortfolio, enforceHours }) {
  const [watchlistData, setWatchlistData] = useState({});   // { "PTT.BK": quote, ... }
  const [priceHistory, setPriceHistory]   = useState([]);   // ticks for active symbol chart
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [lastUpdated, setLastUpdated]     = useState(null);

  const intervalRef   = useRef(null);
  const prevSymbolRef = useRef(null);

  // ── Fetch all watchlist quotes (batch) ────────────────────────────────────
  const fetchWatchlist = useCallback(async () => {
    try {
      const symbolsParam = WATCHLIST.join(",");
      const res  = await fetch(`${WORKER_SET}?symbols=${encodeURIComponent(symbolsParam)}`);
      if (!res.ok) throw new Error(`SET Worker returned ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "SET Worker error");

      setWatchlistData(json.data || {});
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(`SET data unavailable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Update chart ticks when active symbol data arrives ────────────────────
  useEffect(() => {
    const quote = watchlistData[activeSymbol];
    if (!quote?.ticks?.length) return;

    // If symbol changed — reset history to fresh ticks from the new symbol
    if (prevSymbolRef.current !== activeSymbol) {
      setPriceHistory(quote.ticks);
      prevSymbolRef.current = activeSymbol;
      return;
    }

    // Same symbol — append latest tick if it's a new minute
    const latestTick = quote.ticks[quote.ticks.length - 1];
    if (!latestTick) return;

    setPriceHistory(prev => {
      if (!prev.length) return quote.ticks;

      const last = prev[prev.length - 1];
      if (last.time === latestTick.time) {
        // Update last candle in place
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            high:   Math.max(last.high,  latestTick.close),
            low:    Math.min(last.low,   latestTick.close),
            close:  latestTick.close,
            volume: latestTick.volume,
          },
        ];
      }
      // New minute — append, keep last 390
      return [...prev.slice(-389), latestTick];
    });
  }, [watchlistData, activeSymbol]);

  // Mount: fetch immediately then poll every 60s
  useEffect(() => {
    fetchWatchlist();
    intervalRef.current = setInterval(fetchWatchlist, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchWatchlist]);

  // Auto-check SL/TP on every watchlist update
  useEffect(() => {
    if (!Object.keys(watchlistData).length) return;

    // Build price map from all watchlist quotes
    const priceMap = {};
    Object.entries(watchlistData).forEach(([sym, q]) => {
      if (q?.price) priceMap[sym] = q.price;
    });

    const updated  = updatePositionPrices(portfolio, priceMap);
    const toClose  = updated.positions.filter(p => p.autoClose && p.market === "set");

    if (toClose.length > 0) {
      let current = updated;
      toClose.forEach(pos => {
        const { portfolio: next } = executeSell(current, pos.id, pos.autoClose.price);
        current = next;
      });
      setPortfolio(current);
    } else if (updated.positions.some(p => p.market === "set")) {
      setPortfolio(updated);
    }
  }, [watchlistData]);

  // ── Trade handlers ────────────────────────────────────────────────────────
  const handleBuy = useCallback((order) => {
    const result = executeBuy(portfolio, {
      ...order,
      symbol: activeSymbol,
      market: "set",
    });
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade, warning: result.warning };
  }, [portfolio, activeSymbol]);

  const handleSell = useCallback((positionId, price) => {
    const closePrice = price || watchlistData[activeSymbol]?.price;
    const result = executeSell(portfolio, positionId, closePrice);
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade };
  }, [portfolio, activeSymbol, watchlistData]);

  const marketOpen = isMarketOpen("set", enforceHours);

  // Active symbol's current quote
  const activeQuote = watchlistData[activeSymbol] || null;

  return {
    watchlistData,
    activeQuote,
    priceHistory,
    loading,
    error,
    lastUpdated,
    marketOpen,
    handleBuy,
    handleSell,
  };
}
