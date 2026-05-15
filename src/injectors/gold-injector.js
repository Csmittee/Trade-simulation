/**
 * gold-injector.js
 * All gold market data fetching, price parsing, and trade wiring.
 * Used by GoldMarket.jsx — isolated so it never pollutes SET logic.
 *
 * ⚠️ KNOWN LIMITATION — Historical THB conversion:
 * The fetchHistory() call converts past OHLC USD prices to THB using the
 * CURRENT live THB rate at page load time — not the exact rate that existed
 * for each historical candle. Acceptable for a paper trading simulator.
 * Do not use for real financial analysis.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import config from "../../config.js";
import { executeBuy, executeSell, updatePositionPrices, isMarketOpen } from "../core/portfolio-engine.js";

const WORKER_GOLD    = config.workers.base + config.workers.routes.gold;
const WORKER_HISTORY = config.workers.base + "/api/history";
const WORKER_INTEL   = config.workers.base + config.workers.routes.intel;
const REFRESH_MS     = config.data.gold.refreshIntervalMs;

/**
 * useGoldMarket — custom hook for all gold market state.
 * Returns everything GoldMarket.jsx needs.
 */
export function useGoldMarket({ portfolio, setPortfolio, enforceHours }) {
  const [goldData, setGoldData]         = useState(null);       // { xauusd, thbRate, thaiGold }
  const [priceHistory, setPriceHistory] = useState([]);         // OHLC candles for chart
  const [historyLoaded, setHistoryLoaded] = useState(false);    // true once historical fetch done
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [partial, setPartial]           = useState(false);      // true if one source failed

  const intervalRef    = useRef(null);
  const historyLoadRef = useRef(false); // prevent double-fetch in StrictMode

  // ── Fetch historical OHLC on mount ──────────────────────────────────────────
  // Runs once. Seeds priceHistory with real past candles so chart isn't empty.
  // ⚠️ THB conversion uses current live rate — see file header note.
  const fetchHistory = useCallback(async () => {
    if (historyLoadRef.current) return; // already fetched (StrictMode double-invoke guard)
    historyLoadRef.current = true;

    try {
      // 1D range, 5m interval = ~78 candles covering today's session
      const res = await fetch(
        `${WORKER_HISTORY}?symbol=GC%3DF&range=1d&interval=5m&market=gold`
      );
      if (!res.ok) throw new Error(`History Worker returned ${res.status}`);
      const json = await res.json();

      if (!json.success || !json.data?.length) {
        // History fetch failed or returned empty (weekend/holiday) — chart will
        // fill from live ticks instead. Not an error worth showing the user.
        return;
      }

      setPriceHistory(json.data);
    } catch (e) {
      // Non-fatal — chart will still work with live ticks
      console.warn("Historical candle fetch failed:", e.message);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  // ── Fetch latest gold price (runs every 60s) ─────────────────────────────────
  const fetchGold = useCallback(async () => {
    try {
      const res = await fetch(WORKER_GOLD);
      if (!res.ok) throw new Error(`Worker returned ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown Worker error");

      setGoldData(json.data);
      setPartial(json.partial || false);
      setLastUpdated(new Date());
      setError(null);

      // Append / update the latest candle with the live tick
      // This runs AFTER history is loaded so it appends correctly
      setPriceHistory(prev => {
        const livePrice = json.data.thaiGold.price;
        const newPoint = {
          time:   formatTime(new Date()),
          open:   prev.length > 0 ? prev[prev.length - 1].close : livePrice,
          high:   livePrice,
          low:    livePrice,
          close:  livePrice,
          xauusd: json.data.xauusd.price,
        };

        // If last candle is the same minute — update its high/low/close in place
        if (prev.length > 0 && prev[prev.length - 1].time === newPoint.time) {
          const last = prev[prev.length - 1];
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              high:  Math.max(last.high,  livePrice),
              low:   Math.min(last.low,   livePrice),
              close: livePrice,
            },
          ];
        }

        // New minute — append new candle, keep last 390 points max
        return [...prev.slice(-389), newPoint];
      });

    } catch (e) {
      setError(`Gold data unavailable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Mount: fetch history first, then start live polling
  useEffect(() => {
    fetchHistory();
    fetchGold();
    intervalRef.current = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchHistory, fetchGold]);

  // Auto-check stop loss / take profit on price update
  useEffect(() => {
    if (!goldData?.thaiGold?.price) return;
    const priceMap = {
      XAUUSD:         goldData.xauusd.price,
      THAI_GOLD_BAHT: goldData.thaiGold.price,
    };
    const updated = updatePositionPrices(portfolio, priceMap);

    // Trigger auto-close for any position that hit SL/TP
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

  // ── Trade handlers ───────────────────────────────────────────────────────────
  const handleBuy = useCallback((order) => {
    const fullOrder = {
      ...order,
      symbol: order.price === goldData?.xauusd?.price ? "XAUUSD" : "THAI_GOLD_BAHT",
      market: "gold",
    };
    const result = executeBuy(portfolio, fullOrder);
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade, warning: result.warning };
  }, [portfolio, goldData]);

  const handleSell = useCallback((positionId, price) => {
    const closePrice = price || goldData?.thaiGold?.price;
    const result = executeSell(portfolio, positionId, closePrice);
    if (result.error) return { error: result.error };
    setPortfolio(result.portfolio);
    return { trade: result.trade };
  }, [portfolio, goldData]);

  // ── Insider Intel ─────────────────────────────────────────────────────────────
  const fetchIntel = useCallback(async (symbol, date) => {
    const res = await fetch(`${WORKER_INTEL}?symbol=${symbol}&date=${date}&market=gold`);
    if (!res.ok) throw new Error("Intel Worker failed");
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  }, []);

  const marketOpen = isMarketOpen("gold", enforceHours);

  return {
    goldData,
    priceHistory,
    historyLoaded,  // can use in GoldMarket.jsx to show "loading history..." if needed
    loading,
    error,
    partial,
    lastUpdated,
    marketOpen,
    handleBuy,
    handleSell,
    fetchIntel,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
