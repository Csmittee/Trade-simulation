/**
 * set-injector.js
 * All SET/MAI market data fetching and trade wiring.
 * Used by SetMarket.jsx — isolated from gold logic (L006).
 *
 * Timeframe fix (Phase 2):
 * fetchHistory re-fetches with correct range/interval when timeframe changes.
 * 1D → range=1d&interval=5m
 * 1W → range=5d&interval=15m
 * 1M → range=1mo&interval=1h
 *
 * ⚠️ SET data is 15-min delayed via Yahoo Finance free tier (L002).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import config from "../../config.js";
import { executeBuy, executeSell, updatePositionPrices, isMarketOpen } from "../core/portfolio-engine.js";

const WORKER_SET   = config.workers.base + config.workers.routes.set;
const WORKER_HIST  = config.workers.base + "/api/history";
const REFRESH_MS   = config.data.set.refreshIntervalMs;
const WATCHLIST    = config.data.set.watchlistDefault;

const TF_PARAMS = {
  "1D": { range: "1d",  interval: "5m"  },
  "1W": { range: "5d",  interval: "15m" },
  "1M": { range: "1mo", interval: "1d"  }, // daily candles for 1M — Yahoo 1h unreliable for SET
};

export function useSetMarket({ activeSymbol, portfolio, setPortfolio, enforceHours, timeframe }) {
  const [watchlistData, setWatchlistData]   = useState({});
  const [priceHistory, setPriceHistory]     = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);
  const [lastUpdated, setLastUpdated]       = useState(null);

  const intervalRef   = useRef(null);
  const prevSymbol    = useRef(null);
  const prevTimeframe = useRef(null);

  // ── Fetch historical OHLC for active symbol ──────────────────────────────────
  // Called when symbol or timeframe changes.
  const fetchHistory = useCallback(async (symbol, tf) => {
    const { range, interval } = TF_PARAMS[tf] || TF_PARAMS["1D"];
    setHistoryLoading(true);
    try {
      const encoded = encodeURIComponent(symbol);
      const res = await fetch(
        `${WORKER_HIST}?symbol=${encoded}&range=${range}&interval=${interval}&market=set`
      );
      if (!res.ok) throw new Error(`History returned ${res.status}`);
      const json = await res.json();
      if (!json.success || !json.data?.length) {
        console.warn(`SET history empty for ${symbol} ${tf}`);
        return;
      }
      setPriceHistory(json.data);
    } catch (e) {
      console.warn("SET history fetch failed:", e.message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Re-fetch when symbol or timeframe changes
  useEffect(() => {
    const symbolChanged    = prevSymbol.current    !== activeSymbol;
    const timeframeChanged = prevTimeframe.current !== timeframe;
    if (!symbolChanged && !timeframeChanged) return;
    prevSymbol.current    = activeSymbol;
    prevTimeframe.current = timeframe;
    setPriceHistory([]); // clear old data immediately so chart shows loading
    fetchHistory(activeSymbol, timeframe);
  }, [activeSymbol, timeframe, fetchHistory]);

  // ── Fetch watchlist quotes (batch, every 60s) ────────────────────────────────
 const fetchWatchlist = useCallback(async () => {
    try {
      // Always include the active symbol so its quote/price is always available
      const symSet = new Set([...WATCHLIST, activeSymbol]);
      const symbolsParam = [...symSet].join(",");
      const res  = await fetch(`${WORKER_SET}?symbols=${encodeURIComponent(symbolsParam)}`);
      if (!res.ok) throw new Error(`SET Worker returned ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "SET Worker error");
      setWatchlistData(json.data || {});
      setLastUpdated(new Date());
      setError(null);

      // In 1D mode — append latest tick from watchlist to chart
      if (timeframe === "1D") {
        const quote = json.data?.[activeSymbol];
        if (quote?.ticks?.length) {
          const latestTick = quote.ticks[quote.ticks.length - 1];
          // Ensure label field exists (SET ticks from watchlist use time as label for 1D)
          const tickWithLabel = { ...latestTick, label: latestTick.label || latestTick.time };
          setPriceHistory(prev => {
            if (!prev.length) return quote.ticks.map(t => ({ ...t, label: t.label || t.time }));
            const last = prev[prev.length - 1];
            if (last.time === tickWithLabel.time) {
              return [...prev.slice(0, -1), {
                ...last,
                high:   Math.max(last.high,  tickWithLabel.close),
                low:    Math.min(last.low,   tickWithLabel.close),
                close:  tickWithLabel.close,
                volume: tickWithLabel.volume,
              }];
            }
            return [...prev.slice(-77), tickWithLabel];
          });
        }
      }
    } catch (e) {
      setError(`SET data unavailable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [activeSymbol, timeframe]);

  // Mount: start watchlist polling
  useEffect(() => {
    fetchWatchlist();
    intervalRef.current = setInterval(fetchWatchlist, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchWatchlist]);

  // Auto SL/TP check
  useEffect(() => {
    if (!Object.keys(watchlistData).length) return;
    const priceMap = {};
    Object.entries(watchlistData).forEach(([sym, q]) => {
      if (q?.price) priceMap[sym] = q.price;
    });
    const updated = updatePositionPrices(portfolio, priceMap);
    const toClose = updated.positions.filter(p => p.autoClose && p.market === "set");
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

  // Trade handlers
  const handleBuy = useCallback((order) => {
    const result = executeBuy(portfolio, { ...order, symbol: activeSymbol, market: "set" });
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

  return {
    watchlistData,
    activeQuote:    watchlistData[activeSymbol] || null,
    priceHistory,
    historyLoading,
    loading,
    error,
    lastUpdated,
    marketOpen:     isMarketOpen("set", enforceHours),
    handleBuy,
    handleSell,
  };
}
