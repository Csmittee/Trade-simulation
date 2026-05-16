/**
 * gold-injector.js
 * All gold market data fetching, price parsing, and trade wiring.
 * Used by GoldMarket.jsx — isolated from SET logic (L006).
 *
 * Timeframe fix (Phase 2):
 * fetchHistory now accepts a timeframe param and re-fetches with correct
 * range/interval when the user switches between 1D / 1W / 1M.
 * Timeframe map: 1D → range=1d&interval=5m
 *                1W → range=5d&interval=15m
 *                1M → range=1mo&interval=1h
 *
 * ⚠️ KNOWN LIMITATION — Historical THB conversion:
 * Historical USD OHLC prices are converted to THB using the CURRENT live rate,
 * not the exact rate at each historical candle. Acceptable for sim. (L001)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import config from "../../config.js";
import { executeBuy, executeSell, updatePositionPrices, isMarketOpen } from "../core/portfolio-engine.js";

const WORKER_GOLD    = config.workers.base + config.workers.routes.gold;
const WORKER_HISTORY = config.workers.base + "/api/history";
const WORKER_INTEL   = config.workers.base + config.workers.routes.intel;
const REFRESH_MS     = config.data.gold.refreshIntervalMs;

// Timeframe → Worker params mapping
const TF_PARAMS = {
  "1D": { range: "1d",  interval: "5m"  },
  "1W": { range: "5d",  interval: "15m" },
  "1M": { range: "1mo", interval: "1h"  },
};

export function useGoldMarket({ portfolio, setPortfolio, enforceHours, timeframe }) {
  const [goldData, setGoldData]           = useState(null);
  const [priceHistory, setPriceHistory]   = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [lastUpdated, setLastUpdated]     = useState(null);
  const [partial, setPartial]             = useState(false);

  const intervalRef    = useRef(null);
  const prevTimeframe  = useRef(null);

  // ── Fetch historical OHLC ────────────────────────────────────────────────────
  // Called on mount AND whenever timeframe changes.
  // Live ticks from fetchGold() append on top after history loads.
  const fetchHistory = useCallback(async (tf) => {
    const { range, interval } = TF_PARAMS[tf] || TF_PARAMS["1D"];
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `${WORKER_HISTORY}?symbol=GC%3DF&range=${range}&interval=${interval}&market=gold`
      );
      if (!res.ok) throw new Error(`History Worker returned ${res.status}`);
      const json = await res.json();

      if (!json.success || !json.data?.length) {
        // Empty = market closed (weekend/holiday) — keep existing data, don't blank chart
        console.warn(`Gold history empty for ${tf} — market may be closed`);
        return;
      }
      setPriceHistory(json.data);
    } catch (e) {
      console.warn("Gold history fetch failed:", e.message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Re-fetch history when timeframe changes
  useEffect(() => {
    if (prevTimeframe.current === timeframe) return;
    prevTimeframe.current = timeframe;
    fetchHistory(timeframe);
  }, [timeframe, fetchHistory]);

  // ── Live price polling (every 60s) ───────────────────────────────────────────
  const fetchGold = useCallback(async () => {
    try {
      const res  = await fetch(WORKER_GOLD);
      if (!res.ok) throw new Error(`Worker returned ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown Worker error");

      setGoldData(json.data);
      setPartial(json.partial || false);
      setLastUpdated(new Date());
      setError(null);

      // Only append live ticks in 1D mode — other timeframes show historical candles
      if (timeframe === "1D") {
        setPriceHistory(prev => {
          const livePrice = json.data.thaiGold.price;
          const newPoint  = {
            time:   formatTime(new Date()),
            open:   prev.length > 0 ? prev[prev.length - 1].close : livePrice,
            high:   livePrice,
            low:    livePrice,
            close:  livePrice,
            xauusd: json.data.xauusd.price,
          };
          if (prev.length > 0 && prev[prev.length - 1].time === newPoint.time) {
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), {
              ...last,
              high:  Math.max(last.high,  livePrice),
              low:   Math.min(last.low,   livePrice),
              close: livePrice,
            }];
          }
          return [...prev.slice(-389), newPoint];
        });
      }
    } catch (e) {
      setError(`Gold data unavailable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [timeframe]);

  // Mount: fetch history for default timeframe, start live polling
  useEffect(() => {
    fetchHistory(timeframe);
    fetchGold();
    intervalRef.current = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto SL/TP check on price update
  useEffect(() => {
    if (!goldData?.thaiGold?.price) return;
    const priceMap = {
      XAUUSD:         goldData.xauusd.price,
      THAI_GOLD_BAHT: goldData.thaiGold.price,
    };
    const updated = updatePositionPrices(portfolio, priceMap);
    const toClose = updated.positions.filter(p => p.autoClose && p.market === "gold");
    if (toClose.length > 0) {
      let current = updated;
      toClose.forEach(pos => {
        const { portfolio: next } = executeSell(current, pos.id, pos.autoClose.price);
        current = next;
      });
      setPortfolio(current);
    } else if (updated.positions.some(p => p.market === "gold")) {
      setPortfolio(updated);
    }
  }, [goldData]);

  // Trade handlers
  const handleBuy = useCallback((order) => {
    const result = executeBuy(portfolio, {
      ...order,
      symbol: "THAI_GOLD_BAHT",
      market: "gold",
    });
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade, warning: result.warning };
  }, [portfolio]);

  const handleSell = useCallback((positionId, price) => {
    const closePrice = price || goldData?.thaiGold?.price;
    const result = executeSell(portfolio, positionId, closePrice);
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade };
  }, [portfolio, goldData]);

  const fetchIntel = useCallback(async (symbol, date) => {
    const res  = await fetch(`${WORKER_INTEL}?symbol=${symbol}&date=${date}&market=gold`);
    if (!res.ok) throw new Error("Intel Worker failed");
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  }, []);

  return {
    goldData,
    priceHistory,
    historyLoading,
    loading,
    error,
    partial,
    lastUpdated,
    marketOpen: isMarketOpen("gold", enforceHours),
    handleBuy,
    handleSell,
    fetchIntel,
  };
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}
