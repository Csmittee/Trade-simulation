/**
 * gold-injector.js
 * All gold market data fetching, price parsing, and trade wiring.
 * Used by GoldMarket.jsx — isolated so it never pollutes SET logic.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import config from "../../config.js";
import { executeBuy, executeSell, updatePositionPrices, isMarketOpen } from "../core/portfolio-engine.js";

const WORKER_GOLD = config.workers.base + config.workers.routes.gold;
const WORKER_INTEL = config.workers.base + config.workers.routes.intel;
const REFRESH_MS = config.data.gold.refreshIntervalMs;

/**
 * useGoldMarket — custom hook for all gold market state.
 * Returns everything GoldMarket.jsx needs.
 */
export function useGoldMarket({ portfolio, setPortfolio, enforceHours }) {
  const [goldData, setGoldData] = useState(null);       // { xauusd, thbRate, thaiGold }
  const [priceHistory, setPriceHistory] = useState([]); // for chart
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [partial, setPartial] = useState(false);        // true if one source failed

  const intervalRef = useRef(null);

  // ── Fetch latest gold price ──────────────────────────────────────────────────
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

      // Append to price history for chart (keep last 390 data points = ~1 trading week at 1min)
      setPriceHistory(prev => {
        const newPoint = {
          time: formatTime(new Date()),
          open:  prev.length > 0 ? prev[prev.length - 1].close : json.data.thaiGold.price,
          high:  json.data.thaiGold.price,
          low:   json.data.thaiGold.price,
          close: json.data.thaiGold.price,
          xauusd: json.data.xauusd.price,
        };

        // Update last candle's high/low if within the same minute
        if (prev.length > 0 && prev[prev.length - 1].time === newPoint.time) {
          const last = prev[prev.length - 1];
          const updated = {
            ...last,
            high:  Math.max(last.high, newPoint.close),
            low:   Math.min(last.low,  newPoint.close),
            close: newPoint.close,
          };
          return [...prev.slice(0, -1), updated];
        }

        return [...prev.slice(-389), newPoint];
      });

    } catch (e) {
      setError(`Gold data unavailable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Start polling on mount
  useEffect(() => {
    fetchGold();
    intervalRef.current = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchGold]);

  // Auto-check stop loss / take profit on price update
  useEffect(() => {
    if (!goldData?.thaiGold?.price) return;
    const priceMap = {
      XAUUSD:          goldData.xauusd.price,
      THAI_GOLD_BAHT:  goldData.thaiGold.price,
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
