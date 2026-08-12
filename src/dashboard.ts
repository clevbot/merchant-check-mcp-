import type { Env } from "./types";
import { BASE_MAINNET_NETWORK } from "./refresh/indexer";
import { SOLANA_MAINNET_NETWORK } from "./refresh/solana-indexer";
import { CATEGORIES } from "./categorize/types";

interface DashboardRow {
  wallet_address: string;
  chain: string;
  tier: string;
  reasons_json: string | null;
  total_tx_count: number;
  unique_payer_count: number;
  wallet_age_days: number | null;
  refreshed_at: number;
  /** Null until src/categorize has run for this wallet at least once. */
  category: string | null;
  /** Raw JSON string — parse before use, same pattern as reasons_json. NULL until ingested at least once. */
  platforms_json: string | null;
}

type TierCounts = { trusted: number; caution: number; avoid: number };

interface DashboardData {
  rows: DashboardRow[];
  /** Combined across both chains — shown alongside, never instead of, the per-chain breakdown below. See requirement note at renderDashboardHtml. */
  counts: TierCounts;
  /** Kept separate from `counts` deliberately — see README "Solana signal caveats": Solana's ~4x faster finality means signal 6 (velocity/harness-break) can't yet be assumed to behave the same as it does on Base, so a single pooled "trusted %" would blend two not-yet-cross-validated methodologies. Both breakdowns stay available even though signal 6 is currently a no-op (always 0) on both chains — the split doesn't cost anything and stays correct once signal 6 is real. */
  countsByChain: { base: TierCounts; solana: TierCounts };
  lastRefreshedAt: number | null;
}

export async function getDashboardData(env: Env): Promise<DashboardData> {
  // is_demo excludes the two synthetic rows; network restricts to the real
  // mainnet networks this app actually ingests (Base mainnet + Solana
  // mainnet) — excludes the demo rows' Base Sepolia network as a second,
  // independent guard against the same failure mode (fake/testnet data
  // reaching the public dashboard), not merely a duplicate of is_demo=0.
  const { results } = await env.DB.prepare(
    `SELECT wallet_address, chain, tier, reasons_json, total_tx_count, unique_payer_count,
            wallet_age_days, refreshed_at, category, platforms_json
     FROM merchant_signals
     WHERE is_demo = 0 AND network IN (?, ?)
     ORDER BY total_tx_count DESC
     LIMIT 1000`,
  )
    .bind(BASE_MAINNET_NETWORK, SOLANA_MAINNET_NETWORK)
    .all<DashboardRow>();

  const counts: TierCounts = { trusted: 0, caution: 0, avoid: 0 };
  const countsByChain = { base: { trusted: 0, caution: 0, avoid: 0 }, solana: { trusted: 0, caution: 0, avoid: 0 } };
  let lastRefreshedAt: number | null = null;
  for (const row of results) {
    if (row.tier === "trusted" || row.tier === "caution" || row.tier === "avoid") {
      counts[row.tier]++;
      if (row.chain === "base" || row.chain === "solana") {
        countsByChain[row.chain][row.tier]++;
      }
    }
    if (lastRefreshedAt === null || row.refreshed_at > lastRefreshedAt) {
      lastRefreshedAt = row.refreshed_at;
    }
  }

  return { rows: results, counts, countsByChain, lastRefreshedAt };
}

/** JSON API — same data the HTML table renders, for anyone who wants raw access. */
export function dashboardDataToJson(data: DashboardData): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

interface PlatformEntry {
  url: string;
  serviceName: string | null;
}

/** Renders the platforms_json cell — clickable hostname(s), falls back to "—" when nothing's been ingested yet (not an error state, just unmeasured, same as other NULL-until-ingested fields). */
function renderPlatformsCell(platformsJson: string | null): string {
  if (!platformsJson) return '<span class="pill pill-muted">—</span>';
  let platforms: PlatformEntry[];
  try {
    const parsed = JSON.parse(platformsJson);
    platforms = Array.isArray(parsed) ? parsed : [];
  } catch {
    return '<span class="pill pill-muted">—</span>';
  }
  if (platforms.length === 0) return '<span class="pill pill-muted">—</span>';

  const links = platforms.map((p) => {
    let hostname = p.url;
    try {
      hostname = new URL(p.url).hostname;
    } catch {
      // Not a parseable absolute URL — show the raw string as-is rather than failing.
    }
    const label = escapeHtml(p.serviceName || hostname);
    return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(p.url)}">${label}</a>`;
  });
  const shown = links.slice(0, 1).join("");
  const extra = links.length > 1 ? ` <span class="pill pill-muted">+${links.length - 1} more</span>` : "";
  return shown + extra;
}

export function renderDashboardHtml(data: DashboardData): string {
  const { rows, counts, countsByChain, lastRefreshedAt } = data;
  const total = counts.trusted + counts.caution + counts.avoid;
  const pct = (n: number, denom: number) => (denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0);
  const chainTotal = (c: TierCounts) => c.trusted + c.caution + c.avoid;
  const baseTotal = chainTotal(countsByChain.base);
  const solanaTotal = chainTotal(countsByChain.solana);

  const rowsHtml = rows
    .map((r) => {
      const reasons: string[] = r.reasons_json ? JSON.parse(r.reasons_json) : [];
      const category = r.category ?? "uncategorized";
      const chain = r.chain === "solana" ? "solana" : "base";
      return `<tr data-tier="${r.tier}" data-category="${category}" data-chain="${chain}" data-address="${escapeHtml(r.wallet_address)}">
        <td><code class="addr" title="${escapeHtml(r.wallet_address)}">${truncateAddress(r.wallet_address)}</code></td>
        <td><span class="pill pill-chain">${chain}</span></td>
        <td><span class="badge badge-${r.tier}">${r.tier}</span></td>
        <td>${renderPlatformsCell(r.platforms_json)}</td>
        <td><span class="pill">${escapeHtml(category.replace(/_/g, " "))}</span></td>
        <td class="num">${r.total_tx_count.toLocaleString()}</td>
        <td class="num">${r.unique_payer_count.toLocaleString()}</td>
        <td class="reasons">${reasons.map((x) => `<span class="reason">${escapeHtml(x)}</span>`).join("")}</td>
      </tr>`;
    })
    .join("\n");

  const categoryOptions = ["all", ...CATEGORIES, "uncategorized"]
    .map((c) => `<option value="${c}">${c === "all" ? "All categories" : c.replace(/_/g, " ")}</option>`)
    .join("");

  return `<title>x402 Merchant Check — Gradient Decisions</title>
<meta name="description" content="Context for agentic buying decisions: live merchant trust tiers for x402 agent commerce, scored from on-chain signals.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280;
    --trusted: #16a34a; --trusted-bg: #dcfce7; --caution: #b45309; --caution-bg: #fef3c7;
    --avoid: #dc2626; --avoid-bg: #fee2e2; --accent: #4f46e5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af;
      --trusted: #4ade80; --trusted-bg: #14532d; --caution: #fbbf24; --caution-bg: #78350f;
      --avoid: #f87171; --avoid-bg: #7f1d1d; --accent: #818cf8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  header h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  header p.tagline { color: var(--text-dim); margin: 0 0 1.75rem; max-width: 60ch; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1.75rem; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1.1rem;
  }
  .stat-card .n { font-size: 1.6rem; font-weight: 650; }
  .stat-card .label { font-size: .8rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .03em; }
  .stat-card.trusted .n { color: var(--trusted); }
  .stat-card.caution .n { color: var(--caution); }
  .stat-card.avoid .n { color: var(--avoid); }
  .bars { display: flex; height: 10px; border-radius: 6px; overflow: hidden; margin-bottom: 2rem; border: 1px solid var(--border); }
  .bar-trusted { background: var(--trusted); }
  .bar-caution { background: var(--caution); }
  .bar-avoid { background: var(--avoid); }
  .controls { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center; }
  .controls input[type=search] {
    flex: 1; min-width: 200px; padding: .55rem .8rem; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: .9rem;
  }
  .filter-btn {
    padding: .45rem .85rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text-dim); font-size: .82rem; cursor: pointer;
  }
  .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
  th, td { text-align: left; padding: .6rem .85rem; border-bottom: 1px solid var(--border); font-size: .87rem; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-dim); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code.addr { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .82rem; }
  .badge { display: inline-block; padding: .15rem .55rem; border-radius: 999px; font-size: .76rem; font-weight: 600; text-transform: capitalize; }
  .badge-trusted { background: var(--trusted-bg); color: var(--trusted); }
  .badge-caution { background: var(--caution-bg); color: var(--caution); }
  .badge-avoid { background: var(--avoid-bg); color: var(--avoid); }
  .reasons { max-width: 320px; }
  .pill {
    display: inline-block; padding: .1rem .5rem; border-radius: 6px; font-size: .76rem;
    text-transform: capitalize; background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
  }
  .pill-chain { text-transform: uppercase; letter-spacing: .02em; font-weight: 600; }
  .pill-muted { text-transform: none; }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  select#category-filter, select#chain-filter {
    padding: .45rem .7rem; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: .82rem;
  }
  .chain-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
  .chain-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: .85rem 1rem; }
  .chain-card .chain-title { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin-bottom: .4rem; }
  .chain-card .chain-stats { display: flex; gap: 1rem; font-size: .85rem; }
  .chain-card .chain-stats b { font-variant-numeric: tabular-nums; }
  .chain-note { font-size: .8rem; color: var(--text-dim); margin: -.5rem 0 1.5rem; max-width: 70ch; }
  .reason {
    display: inline-block; font-size: .74rem; color: var(--text-dim); background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px; padding: .1rem .4rem; margin: .1rem .2rem .1rem 0;
  }
  footer { margin-top: 2.5rem; color: var(--text-dim); font-size: .82rem; }
  footer a { color: var(--accent); }
  .empty { text-align: center; color: var(--text-dim); padding: 2rem; }
  .overflow { overflow-x: auto; }
  code.small { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: .1rem .35rem; font-size: .82rem; }
</style>
<div class="wrap">
  <header>
    <h1>x402 Merchant Check</h1>
    <p class="tagline">
      Context for agentic buying decisions: merchant trust tiers for autonomous agent
      commerce, scored from real on-chain and x402 activity — not a certification, an
      algorithmic read of public signals. Same data agents get via the
      <code class="small">check_merchant</code> MCP tool at
      <code class="small">mcp.gradientdecisions.com</code> ($0.01/query via x402), free to
      browse here. Covers both Base and Solana x402 activity.
    </p>
  </header>

  <div class="stats">
    <div class="stat-card"><div class="n">${total.toLocaleString()}</div><div class="label">Merchants indexed</div></div>
    <div class="stat-card trusted"><div class="n">${counts.trusted}</div><div class="label">Trusted (${pct(counts.trusted, total)}%)</div></div>
    <div class="stat-card caution"><div class="n">${counts.caution}</div><div class="label">Caution (${pct(counts.caution, total)}%)</div></div>
    <div class="stat-card avoid"><div class="n">${counts.avoid}</div><div class="label">Avoid (${pct(counts.avoid, total)}%)</div></div>
  </div>
  <div class="bars">
    <div class="bar-trusted" style="width:${pct(counts.trusted, total)}%"></div>
    <div class="bar-caution" style="width:${pct(counts.caution, total)}%"></div>
    <div class="bar-avoid" style="width:${pct(counts.avoid, total)}%"></div>
  </div>

  <div class="chain-breakdown">
    <div class="chain-card">
      <div class="chain-title">Base</div>
      <div class="chain-stats">
        <span>${baseTotal.toLocaleString()} merchants</span>
        <span class="trusted"><b>${pct(countsByChain.base.trusted, baseTotal)}%</b> trusted</span>
      </div>
    </div>
    <div class="chain-card">
      <div class="chain-title">Solana</div>
      <div class="chain-stats">
        <span>${solanaTotal.toLocaleString()} merchants</span>
        <span class="trusted"><b>${pct(countsByChain.solana.trusted, solanaTotal)}%</b> trusted</span>
      </div>
    </div>
  </div>
  <p class="chain-note">
    Shown separately from the combined figures above on purpose: Solana settles roughly 4x
    faster than Base, and the velocity/anomaly signal hasn't yet been validated as behaving
    the same way across both — see the <code class="small">chain</code> filter below to
    inspect either network on its own.
  </p>

  <div class="controls">
    <input type="search" id="search" placeholder="Search wallet address…" autocomplete="off">
    <button class="filter-btn active" data-tier="all">All</button>
    <button class="filter-btn" data-tier="trusted">Trusted</button>
    <button class="filter-btn" data-tier="caution">Caution</button>
    <button class="filter-btn" data-tier="avoid">Avoid</button>
    <select id="chain-filter">
      <option value="all">All chains</option>
      <option value="base">Base</option>
      <option value="solana">Solana</option>
    </select>
    <select id="category-filter">${categoryOptions}</select>
  </div>

  <div class="overflow">
    <table id="tbl">
      <thead><tr><th>Wallet</th><th>Chain</th><th>Tier</th><th>Platform</th><th>Category</th><th class="num">Calls (30d)</th><th class="num">Unique payers</th><th>Reasons</th></tr></thead>
      <tbody>${rowsHtml || ""}</tbody>
    </table>
    <p class="empty" id="empty" style="display:none">No wallets match.</p>
  </div>

  <footer>
    Data sources: <a href="https://docs.cdp.coinbase.com/x402/bazaar" target="_blank" rel="noopener">x402 Bazaar</a>
    (Base mainnet) and <a href="https://facilitator.payai.network" target="_blank" rel="noopener">PayAI Network</a>
    discovery + Helius RPC (Solana mainnet). Refreshed periodically —
    last update ${lastRefreshedAt ? relativeTime(lastRefreshedAt) : "never"}.
    Part of <strong>Gradient Decisions</strong>. Raw data:
    <a href="/api/wallets">/api/wallets</a>.
  </footer>
</div>
<script>
  const search = document.getElementById('search');
  const buttons = document.querySelectorAll('.filter-btn');
  const categoryFilter = document.getElementById('category-filter');
  const chainFilter = document.getElementById('chain-filter');
  const rows = [...document.querySelectorAll('#tbl tbody tr')];
  const empty = document.getElementById('empty');
  let activeTier = 'all';

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    const activeCategory = categoryFilter.value;
    const activeChain = chainFilter.value;
    let visible = 0;
    for (const row of rows) {
      const tierOk = activeTier === 'all' || row.dataset.tier === activeTier;
      const categoryOk = activeCategory === 'all' || row.dataset.category === activeCategory;
      const chainOk = activeChain === 'all' || row.dataset.chain === activeChain;
      // Search is a plain case-insensitive substring match for UX
      // convenience only — it never writes back a lowercased value anywhere,
      // so it doesn't risk corrupting case-sensitive Solana addresses the
      // way a stored/queried lowercase would (see src/chains.ts).
      const searchOk = !q || row.dataset.address.toLowerCase().includes(q);
      const show = tierOk && categoryOk && chainOk && searchOk;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    empty.style.display = visible === 0 ? '' : 'none';
  }

  search.addEventListener('input', applyFilter);
  categoryFilter.addEventListener('change', applyFilter);
  chainFilter.addEventListener('change', applyFilter);
  buttons.forEach((btn) => btn.addEventListener('click', () => {
    buttons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTier = btn.dataset.tier;
    applyFilter();
  }));
</script>`;
}
