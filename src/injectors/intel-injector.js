/**
 * intel-injector.js
 * Phase 4 — Insider Intel fetch hook.
 *
 * Provides fetchIntel(symbol, date, market) used by ChartPanel via GoldMarket / SetMarket.
 * - Calls Worker /api/intel with symbol + market + date
 * - Worker calls Anthropic with web_search — returns factors, sentiment, confidence
 * - Worker caches result in KV for 24hrs (key: intel:{symbol}:{date})
 * - Frontend also caches in-memory per session (ChartPanel.intelCache ref)
 *
 * Usage:
 *   import { useFetchIntel } from "../injectors/intel-injector.js";
 *   const fetchIntel = useFetchIntel();
 *   // pass fetchIntel as onIntelRequest prop to ChartPanel
 */

import { useCallback } from "react";
import config from "../../config.js";

const WORKER_INTEL = config.workers.base + config.workers.routes.intel;

export function useFetchIntel() {
  const fetchIntel = useCallback(async (symbol, date, market = "gold") => {
    const res = await fetch(
      `${WORKER_INTEL}?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}&market=${market}`,
    );
    if (!res.ok) throw new Error(`Intel Worker returned ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Intel fetch failed");
    return json.data; // { factors, sentiment, confidence, cached }
  }, []);

  return fetchIntel;
}
