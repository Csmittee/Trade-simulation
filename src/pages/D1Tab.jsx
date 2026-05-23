/**
 * D1Tab.jsx
 * Phase 8 — D1 Query Builder
 * SQL generator only — builds queries the user copies into Cloudflare D1 console.
 * No direct database execution. No props needed from Dashboard.
 */

import { useState, useCallback } from "react";

// ── Helpers ────────────────────────────────────────────────────────────────────
const today   = () => new Date().toISOString().slice(0, 10);
const daysAgo = n  => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ── Query registry ────────────────────────────────────────────────────────────
const QUERIES = [
  { id: "recent",        label: "Recent Trades",  icon: "🕐" },
  { id: "by_symbol",     label: "By Symbol",      icon: "🔍" },
  { id: "ghost_buys",    label: "Ghost Buys",     icon: "👻" },
  { id: "by_executor",   label: "By Executor",    icon: "🤖" },
  { id: "trash_data",    label: "Find Trash Data",icon: "🗑"  },
  { id: "confirm_reset", label: "Confirm Reset",  icon: "🔄" },
  { id: "pnl_summary",   label: "P&L Summary",    icon: "📊" },
  { id: "activity_log",  label: "Activity Log",   icon: "📋" },
];

const QUERY_DESCS = {
  ghost_buys:    "Buys with no exit_price — positions that vanished from radar.",
  trash_data:    "Records missing critical fields — useful for spotting corrupted data.",
  confirm_reset: "Run this after pressing Reset to confirm all trades are deleted.",
};

const DEFAULT_FIELDS = {
  recent:        { period: "today", dateFrom: daysAgo(7), dateTo: today() },
  by_symbol:     { symbol: "", side: "all" },
  ghost_buys:    {},
  by_executor:   { executor: "manual" },
  trash_data:    {},
  confirm_reset: {},
  pnl_summary:   { groupBy: "day" },
  activity_log:  { period: "today", type: "all" },
};

// ── SQL builder ───────────────────────────────────────────────────────────────
function buildSQL(queryId, fields) {
  switch (queryId) {
    case "recent": {
      let from;
      if (fields.period === "today")  from = today();
      if (fields.period === "7days")  from = daysAgo(7);
      if (fields.period === "30days") from = daysAgo(30);
      if (fields.period === "custom") from = fields.dateFrom || today();
      const lines = [`SELECT * FROM trades\nWHERE opened_at >= '${from}'`];
      if (fields.period === "custom" && fields.dateTo) {
        lines.push(`  AND opened_at <= '${fields.dateTo} 23:59:59'`);
      }
      lines.push("ORDER BY opened_at DESC;");
      return lines.join("\n");
    }
    case "by_symbol": {
      const sym = (fields.symbol || "").toUpperCase().trim() || "SYMBOL";
      const lines = [`SELECT * FROM trades\nWHERE symbol = '${sym}'`];
      if (fields.side !== "all") lines.push(`  AND side = '${fields.side}'`);
      lines.push("ORDER BY opened_at DESC;");
      return lines.join("\n");
    }
    case "ghost_buys":
      return [
        "SELECT * FROM trades",
        "WHERE side = 'buy'",
        "  AND (exit_price IS NULL OR closed_at IS NULL)",
        "ORDER BY opened_at DESC;",
      ].join("\n");
    case "by_executor": {
      const where =
        fields.executor === "preset" ? "WHERE strategy != 'manual'\n  AND strategy NOT LIKE 'ai_%'"
        : fields.executor === "ai"   ? "WHERE strategy LIKE 'ai_%'\n   OR strategy = 'ai_workflow'"
        :                              "WHERE strategy = 'manual'";
      return `SELECT * FROM trades\n${where}\nORDER BY opened_at DESC;`;
    }
    case "trash_data":
      return [
        "SELECT * FROM trades",
        "WHERE symbol IS NULL",
        "   OR market IS NULL",
        "   OR qty IS NULL",
        "   OR entry_price IS NULL",
        "   OR opened_at IS NULL",
        "ORDER BY opened_at DESC;",
      ].join("\n");
    case "confirm_reset":
      return [
        "SELECT COUNT(*) as total_trades,",
        "       COUNT(CASE WHEN side='buy'  THEN 1 END) as buys,",
        "       COUNT(CASE WHEN side='sell' THEN 1 END) as sells",
        "FROM trades;",
        "-- Expected after reset: total_trades = 0",
      ].join("\n");
    case "pnl_summary": {
      const groupFn =
        fields.groupBy === "week"  ? "strftime('%Y-W%W', closed_at)"
        : fields.groupBy === "month" ? "strftime('%Y-%m', closed_at)"
        :                              "DATE(closed_at)";
      return [
        `SELECT ${groupFn} as period,`,
        "       COUNT(*) as trades,",
        "       ROUND(SUM(pnl), 2) as total_pnl,",
        "       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,",
        "       SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses",
        "FROM trades",
        "WHERE side = 'sell' AND pnl IS NOT NULL",
        `GROUP BY ${groupFn}`,
        "ORDER BY period DESC;",
      ].join("\n");
    }
    case "activity_log": {
      const from = fields.period === "7days" ? daysAgo(7) : today();
      const lines = [`SELECT * FROM activity_log\nWHERE created_at >= '${from}'`];
      if (fields.type !== "all") lines.push(`  AND type = '${fields.type}'`);
      lines.push("ORDER BY created_at DESC\nLIMIT 200;");
      return lines.join("\n");
    }
    default:
      return "";
  }
}

// ── Per-query field renderers ─────────────────────────────────────────────────
function QueryFields({ queryId, fields, onChange }) {
  const set = (k, v) => onChange({ ...fields, [k]: v });

  switch (queryId) {
    case "recent":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Period</label>
            <select value={fields.period} onChange={e => set("period", e.target.value)}>
              <option value="today">Today</option>
              <option value="7days">Last 7 days</option>
              <option value="30days">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select>
          </div>
          {fields.period === "custom" && (
            <>
              <div className="d1-field">
                <label>From</label>
                <input type="date" value={fields.dateFrom} onChange={e => set("dateFrom", e.target.value)} />
              </div>
              <div className="d1-field">
                <label>To</label>
                <input type="date" value={fields.dateTo} onChange={e => set("dateTo", e.target.value)} />
              </div>
            </>
          )}
        </div>
      );
    case "by_symbol":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Symbol</label>
            <input
              type="text"
              value={fields.symbol}
              onChange={e => set("symbol", e.target.value)}
              placeholder="e.g. GULF.BK"
            />
          </div>
          <div className="d1-field">
            <label>Side</label>
            <select value={fields.side} onChange={e => set("side", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
        </div>
      );
    case "by_executor":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Executor</label>
            <select value={fields.executor} onChange={e => set("executor", e.target.value)}>
              <option value="manual">Manual</option>
              <option value="preset">Preset Strategy</option>
              <option value="ai">AI Workflow</option>
            </select>
          </div>
        </div>
      );
    case "pnl_summary":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Group by</label>
            <select value={fields.groupBy} onChange={e => set("groupBy", e.target.value)}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        </div>
      );
    case "activity_log":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Period</label>
            <select value={fields.period} onChange={e => set("period", e.target.value)}>
              <option value="today">Today</option>
              <option value="7days">Last 7 days</option>
            </select>
          </div>
          <div className="d1-field">
            <label>Type</label>
            <select value={fields.type} onChange={e => set("type", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">buy</option>
              <option value="sell">sell</option>
              <option value="block">block</option>
              <option value="strategy">strategy</option>
            </select>
          </div>
        </div>
      );
    default:
      return null;
  }
}

// ── Main component ────────────────────────────────────────────────────────────
export default function D1Tab() {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [fields,        setFields]        = useState({});
  const [generatedSQL,  setGeneratedSQL]  = useState("");
  const [copied,        setCopied]        = useState(false);

  const selectQuery = useCallback((id) => {
    setSelectedQuery(id);
    setFields(DEFAULT_FIELDS[id] || {});
    setGeneratedSQL("");
    setCopied(false);
  }, []);

  const handleGenerate = useCallback(() => {
    setGeneratedSQL(buildSQL(selectedQuery, fields));
    setCopied(false);
  }, [selectedQuery, fields]);

  const handleCopy = useCallback(() => {
    if (!generatedSQL) return;
    navigator.clipboard.writeText(generatedSQL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [generatedSQL]);

  const query = QUERIES.find(q => q.id === selectedQuery);

  return (
    <div className="d1-tab">

      <div className="d1-header">
        <h2>🗄 D1 Query Builder</h2>
        <p>Generate SQL → copy → paste in Cloudflare D1 console. Nothing executes from this tab.</p>
      </div>

      {/* ── 8-button picker grid ── */}
      <div className="d1-query-grid">
        {QUERIES.map(q => (
          <button
            key={q.id}
            className={`d1-query-btn ${selectedQuery === q.id ? "active" : ""}`}
            onClick={() => selectQuery(q.id)}
          >
            <div>{q.icon}</div>
            <div>{q.label}</div>
          </button>
        ))}
      </div>

      {/* ── Selected query: desc + fields + generate ── */}
      {selectedQuery && (
        <div className="d1-query-panel">
          <div className="d1-query-title">{query?.icon} {query?.label}</div>
          {QUERY_DESCS[selectedQuery] && (
            <div className="d1-query-desc">{QUERY_DESCS[selectedQuery]}</div>
          )}
          <QueryFields queryId={selectedQuery} fields={fields} onChange={setFields} />
          <button className="d1-generate-btn" onClick={handleGenerate}>
            Generate SQL
          </button>
        </div>
      )}

      {/* ── SQL output ── */}
      {generatedSQL && (
        <div className="d1-output">
          <div className="d1-output-label">Generated SQL</div>
          <pre className="d1-sql-block">{generatedSQL}</pre>
          <button
            className={`d1-copy-btn ${copied ? "success" : ""}`}
            onClick={handleCopy}
          >
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
        </div>
      )}

      {/* ── Instructions ── */}
      <div className="d1-instructions">
        <div className="d1-instructions-title">Where to run this</div>
        <ol>
          <li>Go to <code>dash.cloudflare.com</code> → <code>Workers &amp; Pages</code> → <code>D1</code></li>
          <li>Open database <code>tts-db</code></li>
          <li>Click the <code>Console</code> tab</li>
          <li>Paste the SQL above → click <code>Run</code></li>
        </ol>
      </div>

    </div>
  );
}
