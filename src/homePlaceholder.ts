/**
 * Public homepage (`/` and `/dashboard`) — redesigned 2026-08-19 from a
 * Figma landing-page mockup the user provided (file vRdeDaQ1zA4jzFhDodJ2eg,
 * frame "gradient-decisions-landing"), pulled via the Figma REST API
 * (no Figma desktop app / Dev Mode MCP available in this environment) and
 * rebuilt as hand-written HTML/CSS, matching this Worker's existing
 * architecture (no framework, no static asset hosting — every page is a
 * generated string, same as src/dashboard.ts and src/merchantProfile.ts).
 *
 * Deliberately NOT a literal copy of the Figma content. The mockup's own
 * copy was generic AI-SaaS placeholder text describing a different product
 * ("real-time price intelligence", "deal validation", "50M+ prices
 * analyzed", "18% average cost savings", "150+ transactional APIs") with no
 * basis in anything this service actually does or measures. What's kept
 * from the Figma is the *visual system* — layout, type scale (Gabarito
 * headings / Geist body / Geist Mono for labels+code), color tokens (peach
 * #fdba74 + pink #fbcfe8 dual-accent, extracted from the file's actual
 * node fills, not eyeballed), card grids, code-block mockup, stats band,
 * and footer structure. All copy and every number below is real:
 * - The stats band renders live getDashboardSummary() data (same aggregate
 *   counts the pre-redesign placeholder showed), not the mockup's invented
 *   figures.
 * - The "how it works" steps describe check_merchant's actual flow.
 * - The integration code block is the real mcp-config.json shape for this
 *   server's actual streamable-HTTP MCP endpoint (see
 *   src/agentReadiness.ts's renderMcpServerCardJson, same origin/transport).
 * - The "real merchants" section names Exa (api.exa.ai) and Vaaya
 *   (vaaya.ai) at the user's explicit request ("we had in our dashboard
 *   before... credible actors in the space") — both confirmed as real,
 *   currently-indexed rows via a direct D1 query before writing this.
 *   Deliberately shows only name/category/what-they-do, never their
 *   computed tier/recommendation/signals: that's exactly the per-merchant
 *   data the "Data access policy" lockdown (see README) retired
 *   /merchant/* and /api/wallets for giving away free, and naming two
 *   specific merchants would re-open that same leak for just those two if
 *   their live verdict were shown here instead of behind the paid tool.
 *
 * Logo lockup (gradient-fill rounded square + "Gradient Decisions"
 * wordmark) is new, matching the Figma nav exactly (gradient stops
 * #fbcfe8→#fdba74, 6px corner radius) — deliberately not routed through
 * src/brand.ts's existing renderMonogram/renderWordmark (the "GD"
 * fade-letter treatment used on /privacy and the internal caller
 * dashboard): that's a different, still-in-use mark, not being replaced
 * site-wide by this task, just not reused here where the source design
 * specifies something else.
 */
import type { DashboardSummary, FeaturedMerchant, RecommendationCounts } from "./dashboard";
import { recommendationLabel, recommendationSlug } from "./dashboard";
import { FAVICON_LINK } from "./brand";

function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const pct = (n: number, denom: number) => (denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0);
const chainTotal = (c: RecommendationCounts) => c.proceed + c.caution + c.insufficientSignal;

/** Figma nav lockup: gradient rounded square + wordmark text, not src/brand.ts's "GD" monogram — see file header. */
function renderLandingLogo(idSuffix: string): string {
  return `<span class="logo">
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="logoGrad-${idSuffix}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fbcfe8"/>
          <stop offset="100%" stop-color="#fdba74"/>
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="6" fill="url(#logoGrad-${idSuffix})"/>
    </svg>
    <span class="logo-word">Gradient Decisions</span>
  </span>`;
}

const FIGMA_FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gabarito:wght@600;700;800&family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600;700&display=swap" rel="stylesheet">`;

const MCP_CONFIG_SNIPPET = `{
  "mcpServers": {
    "gradient-decisions": {
      "url": "https://mcp.gradientdecisions.com/mcp",
      "transport": "streamable-http"
    }
  }
}`;

interface WorkflowStep {
  n: string;
  icon: string;
  title: string;
  body: string;
}

const WORKFLOW_STEPS: WorkflowStep[] = [
  { n: "01", icon: "💬", title: "Merchant Encountered", body: "Agent hits an x402 402 Payment Required challenge from a merchant it hasn't dealt with before." },
  { n: "02", icon: "🔍", title: "check_merchant Call", body: "Agent calls check_merchant with the merchant's wallet address — $0.01, paid via x402 on Base." },
  { n: "03", icon: "▦", title: "Signal Scoring", body: "Wallet age, unique payers, settlement volume, and price fairness vs. category peers, scored from real activity." },
  { n: "04", icon: "✓", title: "Trust Recommendation", body: "Agent gets back PROCEED, CAUTION, or INSUFFICIENT SIGNAL, with the reasons behind it. Decision support, not a certification." },
  { n: "05", icon: "🛒", title: "Agent Decides", body: "Agent uses the recommendation to decide whether to complete the real payment to the merchant." },
];

interface FeatureCard {
  icon: string;
  title: string;
  body: string;
}

const FEATURE_CARDS: FeatureCard[] = [
  { icon: "📊", title: "Real Observable Signals", body: "Wallet age, unique payer count, settlement volume, and price fairness against category peers — computed from real on-chain and x402 activity, not self-reported claims." },
  { icon: "📋", title: "Pre-Payment Trust Scoring", body: "PROCEED / CAUTION / INSUFFICIENT SIGNAL, with the reasons behind each call — decision support for an agent's payment logic, not a certification." },
  { icon: "🔌", title: "MCP-Native, With a Plain-HTTP Fallback", body: "Works out of the box as an MCP tool over streamable HTTP, or as a plain GET /check endpoint for HTTP-only x402 clients." },
];

/**
 * Editorial copy (what a merchant does, and the human-friendly category
 * label) for the two src/dashboard.ts getFeaturedMerchants() wallets —
 * kept separate from the real scoring `category` column (which holds the
 * scoring pipeline's own coarser buckets, e.g. "data_api"/"other") since
 * that's not written as public-facing copy. Everything else about these
 * two cards (tier, recommendation, signals, pricing) is live, not this
 * static copy — see file header and getFeaturedMerchants' own comment for
 * why these two, specifically, are the one deliberate exception to the
 * "Data access policy" lockdown.
 */
const MERCHANT_BLURBS: Record<string, { displayCategory: string; blurb: string }> = {
  Exa: { displayCategory: "Search API", blurb: "Search and content retrieval for agents." },
  Vaaya: { displayCategory: "Agent Tool Gateway", blurb: "Multi-tool x402 gateway — search, scraping, sandboxes, media generation." },
};

function formatUsdPriceRange(pricesAtomic: number[]): string | null {
  if (pricesAtomic.length === 0) return null;
  const usd = pricesAtomic.map((p) => p / 1_000_000);
  const min = Math.min(...usd);
  const max = Math.max(...usd);
  const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

/** Live check_merchant-equivalent card for the two src/dashboard.ts getFeaturedMerchants() wallets — see that function's comment for scope. */
function renderFeaturedMerchantCard(m: FeaturedMerchant): string {
  const copy = MERCHANT_BLURBS[m.name] ?? { displayCategory: m.category, blurb: "" };
  const recSlug = recommendationSlug(m.recommendation);
  const priceRange = formatUsdPriceRange(m.ownPricesAtomic);
  const priceLine =
    priceRange !== null
      ? `<span class="m-signal">${priceRange}${m.priceFairness !== "unknown" ? ` <span class="m-fairness m-fairness-${m.priceFairness}">${m.priceFairness}</span>` : ""}</span>`
      : "";
  return `<div class="merchant-card">
    <div class="m-top">
      <h3>${m.name}</h3>
      <span class="m-badge m-badge-${recSlug}" title="trust_tier: ${m.trustTier.toUpperCase()}">${recommendationLabel(m.recommendation)}</span>
    </div>
    <code class="m-domain">${m.domain}</code>
    <span class="m-cat">${copy.displayCategory} · ${m.chain}</span>
    <p>${copy.blurb}</p>
    <div class="m-signals">
      <span class="m-signal">${m.totalTxCount.toLocaleString()} calls (30d)</span>
      <span class="m-signal">${m.uniquePayerCount.toLocaleString()} unique payers</span>
      ${m.walletAgeDays !== null ? `<span class="m-signal">${m.walletAgeDays}d wallet age</span>` : ""}
      <span class="m-signal">${m.confidence.toLowerCase()} confidence</span>
      ${priceLine}
    </div>
    ${
      m.reasons.length > 0
        ? `<div class="m-reasons">
      <span class="m-reasons-label">Why</span>
      <ul>${m.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
    </div>`
        : ""
    }
  </div>`;
}

export function renderHomePlaceholderHtml(summary: DashboardSummary, featuredMerchants: FeaturedMerchant[]): string {
  const { counts, countsByChain, total, lastRefreshedAt } = summary;
  const baseTotal = chainTotal(countsByChain.base);
  const solanaTotal = chainTotal(countsByChain.solana);

  return `<title>x402 Merchant Check | Gradient Decisions</title>
<meta name="description" content="Pre-payment merchant trust checks for x402 agents, via the check_merchant MCP tool.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FIGMA_FONT_LINKS}
<style>
  :root {
    --bg: #ffffff; --bg-soft: #fff7f2; --bg-muted: #f9fafb; --surface: #ffffff; --border: #e5e7eb;
    --text: #111827; --text-body: #374151; --text-dim: #6b7280;
    --accent: #fdba74; --accent-ink: #7c2d12; --accent-tint: rgba(253,186,116,0.08);
    --accent2: #fbcfe8; --accent2-ink: #9d174d; --accent2-tint: rgba(251,207,232,0.08);
    --proceed: #16a34a; --proceed-bg: #dcfce7; --caution: #b45309; --caution-bg: #fef3c7;
    --insufficient: #6b7280; --insufficient-bg: #f1f1f3;
    --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-xl: 18px; --r-pill: 999px;
    --shadow: 0 1px 2px rgba(17,24,39,.04);
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text-body);
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6; font-size: 16px;
  }
  h1, h2, h3 { font-family: "Gabarito", -apple-system, sans-serif; color: var(--text); margin: 0; letter-spacing: -.01em; }
  a { color: inherit; }
  code, .mono { font-family: "Geist Mono", ui-monospace, SFMono-Regular, monospace; }

  .logo { display: inline-flex; align-items: center; gap: .55rem; text-decoration: none; }
  .logo svg { flex-shrink: 0; }
  .logo-word { font-family: "Gabarito", sans-serif; font-weight: 700; font-size: 1.05rem; color: var(--text); }

  .tag {
    display: inline-block; font-family: "Geist Mono", monospace; font-weight: 600; font-size: .7rem;
    letter-spacing: .06em; text-transform: uppercase; padding: .35rem .85rem; border-radius: var(--r-pill);
    border: 1px solid currentColor;
  }
  /* Translucent-white pill treatment (not a flat tint) — sits directly on
     .gradient-wrap's pink/orange background, not a plain page background,
     so it needs real fill contrast rather than an 8%-opacity tint that
     would nearly disappear against an already-colored backdrop. Only one
     tag left on the page (the hero's) after trimming the rest — each
     section's own heading already said what its tag repeated. */
  .tag.peach { background: rgba(255,255,255,.5); color: #7c2d12; border-color: rgba(17,24,39,.18); }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
    font-family: "Gabarito", sans-serif; font-weight: 600; font-size: .92rem; text-decoration: none;
    padding: .7rem 1.3rem; border-radius: var(--r-md); border: 1px solid transparent; cursor: pointer;
  }
  .btn-primary { background: #ffffff; color: #111827; border-color: rgba(17,24,39,.18); }
  /* Translucent white, not fully transparent — same reasoning as .tag above:
     a hairline var(--border) outline alone would barely register against
     the gradient. */
  .btn-secondary { background: rgba(255,255,255,.4); color: #111827; border-color: rgba(17,24,39,.22); }

  section { padding: 4.5rem 1.5rem; }
  .inner { max-width: 1120px; margin: 0 auto; }
  .section-head { max-width: 640px; margin-bottom: 2.5rem; }
  .section-head .tag { margin-bottom: 1rem; }
  .section-head h2 { font-size: clamp(1.6rem, 3vw, 2.1rem); font-weight: 700; }
  .section-head p { color: var(--text-dim); margin-top: .75rem; }

  nav.topnav {
    display: flex; align-items: center; justify-content: space-between; padding: 1.1rem 1.5rem;
    border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 10;
  }
  nav.topnav .navlinks { display: flex; gap: 1.75rem; font-size: .9rem; }
  nav.topnav .navlinks a { color: var(--text-body); text-decoration: none; }
  nav.topnav .navlinks a:hover { color: var(--text); }
  @media (max-width: 720px) { nav.topnav .navlinks { display: none; } }

  /* Same pink-to-orange gradient as the logo mark (#fbcfe8 -> #fdba74),
     stretched across the wrapper spanning hero through the CTA section
     (see the HTML below) rather than confined to the hero band alone —
     "let's see what it looks like if applied to most of the landing page".
     The wrap's own height comes from its content (no fixed-position/
     viewport tricks needed): a block-level gradient background simply
     fills whatever height its container renders at. Nav and footer stay
     outside it — a plain nav (readable while sticky-scrolling over
     everything below it) and a plain footer (a clear resting point at the
     end) both read better solid than mid-gradient. */
  .gradient-wrap { background: linear-gradient(90deg, #fbcfe8 0%, #fdba74 100%); }
  .hero { text-align: center; padding-top: 5.5rem; padding-bottom: 3.5rem; }
  .hero h1 { font-size: clamp(2.1rem, 5.5vw, 3.4rem); font-weight: 800; line-height: 1.08; max-width: 820px; margin: 1.25rem auto 1.25rem; }
  .hero p.lede { max-width: 620px; margin: 0 auto 2rem; color: var(--text-dim); font-size: 1.05rem; }
  .hero .cta-row { display: flex; gap: .85rem; justify-content: center; flex-wrap: wrap; }

  .workflow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  .step-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 1.25rem; }
  .step-card .step-n { font-family: "Geist Mono", monospace; font-size: .7rem; font-weight: 700; color: var(--text-dim); letter-spacing: .05em; }
  .step-card .step-icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: var(--r-sm); background: var(--accent2-tint); font-size: 1rem; margin: .5rem 0 .75rem; }
  .step-card h3 { font-size: .98rem; font-weight: 700; margin-bottom: .4rem; }
  .step-card p { font-size: .84rem; color: var(--text-dim); margin: 0; }
  .workflow-head-flex { display: flex; justify-content: space-between; gap: 2rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 2rem; }
  .workflow-head-flex .section-head { margin-bottom: 0; }
  .workflow-head-flex .side-note { max-width: 320px; color: var(--text-dim); font-size: .9rem; }

  .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.25rem; }
  .feature-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xl); padding: 1.75rem; }
  .feature-card .f-icon { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: var(--r-md); background: var(--accent-tint); font-size: 1.3rem; margin-bottom: 1rem; }
  .feature-card h3 { font-size: 1.05rem; font-weight: 700; margin-bottom: .5rem; }
  .feature-card p { font-size: .88rem; color: var(--text-dim); margin: 0; }

  .integrate-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: center; }
  @media (max-width: 860px) { .integrate-grid { grid-template-columns: 1fr; } }
  .integrate-copy ul { list-style: none; padding: 0; margin: 1.25rem 0 0; display: flex; flex-direction: column; gap: .55rem; }
  .integrate-copy li { font-size: .88rem; color: var(--text-body); display: flex; gap: .5rem; align-items: baseline; }
  .integrate-copy li::before { content: "✓"; color: var(--proceed); font-weight: 700; }
  .code-window { background: var(--bg-muted); border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; }
  .code-window .code-titlebar { display: flex; align-items: center; justify-content: space-between; padding: .6rem .9rem; border-bottom: 1px solid var(--border); }
  .code-window .dots { display: flex; gap: .35rem; }
  .code-window .dots span { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .code-window .dots span:nth-child(1) { background: #ef4444; }
  .code-window .dots span:nth-child(2) { background: #f59e0b; }
  .code-window .dots span:nth-child(3) { background: #16a34a; }
  .code-window .filename { font-family: "Geist Mono", monospace; font-size: .75rem; color: var(--text-dim); }
  .code-window pre { margin: 0; padding: 1.1rem 1.2rem; font-family: "Geist Mono", monospace; font-size: .8rem; line-height: 1.6; overflow-x: auto; color: var(--text-body); }

  /* Translucent white wash, not the old opaque --bg-muted fill — the dense
     numbers here (and --accent2-ink's maroon tone specifically, which is
     close enough to the gradient's own pink to lose definition without
     help) need more separation from .gradient-wrap's background than the
     lighter card/tag treatment elsewhere on this band. */
  .stats-band { background: rgba(255,255,255,.6); border-top: 1px solid rgba(17,24,39,.1); border-bottom: 1px solid rgba(17,24,39,.1); padding: 3rem 1.5rem; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1.5rem; text-align: center; }
  .stats-grid .n { font-family: "Gabarito", sans-serif; font-size: clamp(1.6rem, 3vw, 2.2rem); font-weight: 800; color: var(--accent2-ink); }
  .stats-grid .n.proceed { color: var(--proceed); }
  .stats-grid .n.caution { color: var(--caution); }
  .stats-grid .n.insufficient { color: var(--insufficient); }
  .stats-grid .label { font-size: .78rem; color: var(--text-dim); margin-top: .3rem; }
  .chain-row { display: flex; gap: 1rem; justify-content: center; margin-top: 2rem; flex-wrap: wrap; }
  .chain-pill { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-pill); padding: .5rem 1.1rem; font-size: .82rem; color: var(--text-body); }
  .chain-pill b { color: var(--text); }
  .refreshed-note { text-align: center; font-size: .78rem; color: var(--text-dim); margin-top: 1.25rem; }

  .merchants-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.25rem; }
  .merchant-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 1.5rem; }
  .merchant-card .m-top { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; margin-bottom: .5rem; }
  .merchant-card h3 { font-size: 1.05rem; font-weight: 700; }
  .merchant-card .m-badge { flex-shrink: 0; font-family: "Geist Mono", monospace; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; border-radius: var(--r-pill); padding: .25rem .65rem; white-space: nowrap; }
  .merchant-card .m-badge-proceed { background: var(--proceed-bg); color: var(--proceed); }
  .merchant-card .m-badge-caution { background: var(--caution-bg); color: var(--caution); }
  .merchant-card .m-badge-insufficient { background: var(--insufficient-bg); color: var(--insufficient); }
  .merchant-card .m-domain { font-family: "Geist Mono", monospace; font-size: .78rem; color: var(--text-dim); display: block; }
  .merchant-card .m-cat { font-size: .78rem; color: var(--accent-ink); display: block; margin: .35rem 0 .6rem; }
  .merchant-card p { font-size: .86rem; color: var(--text-dim); margin: 0 0 .9rem; }
  .merchant-card .m-signals { display: flex; flex-wrap: wrap; gap: .4rem; }
  .merchant-card .m-signal { font-family: "Geist Mono", monospace; font-size: .72rem; color: var(--text-body); background: var(--bg-muted); border: 1px solid var(--border); border-radius: var(--r-sm); padding: .2rem .5rem; }
  .m-fairness-fair { color: var(--proceed); }
  .m-fairness-high { color: var(--caution); }
  .m-fairness-low { color: var(--accent2-ink); }
  .merchant-card .m-reasons { margin-top: 1rem; padding-top: .9rem; border-top: 1px solid var(--border); }
  .merchant-card .m-reasons-label { font-family: "Geist Mono", monospace; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
  .merchant-card .m-reasons ul { list-style: none; margin: .45rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
  .merchant-card .m-reasons li { font-size: .82rem; color: var(--text-body); padding-left: .9rem; position: relative; }
  .merchant-card .m-reasons li::before { content: "—"; position: absolute; left: 0; color: var(--text-dim); }
  .merchants-note { font-size: .8rem; color: var(--text-dim); margin-top: 1.5rem; max-width: 70ch; }

  .cta-section { text-align: center; }
  .cta-section h2 { font-size: clamp(1.7rem, 4vw, 2.4rem); font-weight: 800; max-width: 640px; margin: 1rem auto 1rem; }
  .cta-section p { color: var(--text-dim); max-width: 520px; margin: 0 auto 2rem; }
  .cta-section .cta-row { display: flex; gap: .85rem; justify-content: center; flex-wrap: wrap; }

  footer.sitefoot { border-top: 1px solid var(--border); padding: 3rem 1.5rem 2rem; }
  footer.sitefoot .foot-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 2.5rem; }
  @media (max-width: 720px) { footer.sitefoot .foot-grid { grid-template-columns: 1fr; } }
  footer.sitefoot .foot-brand p { font-size: .88rem; color: var(--text-dim); max-width: 320px; margin-top: .85rem; }
  footer.sitefoot .foot-col h4 { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin-bottom: .85rem; font-weight: 600; }
  footer.sitefoot .foot-col ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .55rem; }
  footer.sitefoot .foot-col a { font-size: .86rem; color: var(--text-body); text-decoration: none; }
  footer.sitefoot .foot-col a:hover { color: var(--text); }
  footer.sitefoot .foot-bottom { border-top: 1px solid var(--border); margin-top: 2.5rem; padding-top: 1.25rem; font-size: .78rem; color: var(--text-dim); display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
  footer.sitefoot .foot-bottom a { color: var(--text-dim); }
</style>

<nav class="topnav">
  <a href="/" style="text-decoration:none">${renderLandingLogo("nav")}</a>
  <div class="navlinks">
    <a href="#features">Features</a>
    <a href="#how-it-works">How It Works</a>
    <a href="/auth.md">Docs</a>
  </div>
</nav>

<div class="gradient-wrap">
<section class="hero">
  <div class="inner">
    <span class="tag peach">PRE-PAYMENT TRUST LAYER FOR X402</span>
    <h1>The Last Check Before Your Agent Pays.</h1>
    <p class="lede">
      <code class="mono">check_merchant</code> gives autonomous agents a trust recommendation — PROCEED, CAUTION, or
      INSUFFICIENT SIGNAL — built from a merchant's observable on-chain and x402 settlement history, before it
      commits to a real payment.
    </p>
    <div class="cta-row">
      <a class="btn btn-secondary" href="#integrate">Start Integrating</a>
    </div>
  </div>
</section>

<section id="how-it-works">
  <div class="inner">
    <div class="workflow-head-flex">
      <div class="section-head">
        <h2>How check_merchant Fits Into Agentic Commerce</h2>
      </div>
      <p class="side-note">Agents are autonomous but still need a trust check at the moment of payment. Here's where Gradient Decisions sits in that loop.</p>
    </div>
    <div class="workflow-grid">
      ${WORKFLOW_STEPS.map(
        (s) => `<div class="step-card">
        <span class="step-n">STEP ${s.n}</span>
        <div class="step-icon">${s.icon}</div>
        <h3>${s.title}</h3>
        <p>${s.body}</p>
      </div>`,
      ).join("\n")}
    </div>
  </div>
</section>

<section id="features">
  <div class="inner">
    <div class="section-head">
      <h2>Built Specifically For Autonomous Commerce</h2>
    </div>
    <div class="features-grid">
      ${FEATURE_CARDS.map(
        (f) => `<div class="feature-card">
        <div class="f-icon">${f.icon}</div>
        <h3>${f.title}</h3>
        <p>${f.body}</p>
      </div>`,
      ).join("\n")}
    </div>
  </div>
</section>

<section id="integrate">
  <div class="inner">
    <div class="integrate-grid">
      <div class="integrate-copy">
        <h2 style="font-size:clamp(1.5rem,3vw,2rem);font-weight:700;">Integrate in Minutes</h2>
        <p style="color:var(--text-dim);margin-top:.85rem;">
          Gradient Decisions works natively via MCP over streamable HTTP. Add it as a remote server and your agent
          can call <code class="mono">check_merchant</code> directly — no API keys, no accounts, every call
          authenticated by its own x402 payment.
        </p>
        <ul>
          <li>No accounts or API keys — payment is the auth</li>
          <li>$0.01 USDC per check, via x402 on Base mainnet</li>
          <li>Same tool available as plain HTTP at <code class="mono">GET /check</code></li>
        </ul>
      </div>
      <div class="code-window">
        <div class="code-titlebar">
          <div class="dots"><span></span><span></span><span></span></div>
          <span class="filename">mcp-config.json</span>
        </div>
        <pre>${MCP_CONFIG_SNIPPET}</pre>
      </div>
    </div>
  </div>
</section>

<div class="stats-band">
  <div class="inner">
    <div class="stats-grid">
      <div><div class="n">${total.toLocaleString()}</div><div class="label">Merchants indexed</div></div>
      <div><div class="n proceed">${pct(counts.proceed, total)}%</div><div class="label">Proceed (${counts.proceed})</div></div>
      <div><div class="n caution">${pct(counts.caution, total)}%</div><div class="label">Caution (${counts.caution})</div></div>
      <div><div class="n insufficient">${pct(counts.insufficientSignal, total)}%</div><div class="label">Insufficient signal (${counts.insufficientSignal})</div></div>
    </div>
    <div class="chain-row">
      <span class="chain-pill"><b>${baseTotal.toLocaleString()}</b> merchants on Base · <b>${pct(countsByChain.base.proceed, baseTotal)}%</b> proceed</span>
      <span class="chain-pill"><b>${solanaTotal.toLocaleString()}</b> merchants on Solana · <b>${pct(countsByChain.solana.proceed, solanaTotal)}%</b> proceed</span>
    </div>
    <p class="refreshed-note">Last refreshed ${lastRefreshedAt ? relativeTime(lastRefreshedAt) : "never"}. Aggregate counts only — per-merchant results are available via the paid <code class="mono">check_merchant</code> tool.</p>
  </div>
</div>

<section>
  <div class="inner">
    <div class="section-head">
      <h2>Real Merchants In Our Index</h2>
    </div>
    <div class="merchants-grid">
      ${featuredMerchants.map(renderFeaturedMerchantCard).join("\n")}
    </div>
    <p class="merchants-note">Live <code class="mono">check_merchant</code> output for two merchants already in the index — every other merchant's recommendation and signals stay behind the paid tool.</p>
  </div>
</section>

<section class="cta-section">
  <div class="inner">
    <h2>Give Your Agent A Reason To Trust The Payment</h2>
    <p>Add Gradient Decisions to your agent's MCP config in under five minutes. Every check is $0.01, paid the same way as the payment it's protecting.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="#integrate">Integrate MCP Server Now</a>
      <a class="btn btn-secondary" href="/methodology.md">Read the Docs</a>
    </div>
  </div>
</section>
</div>

<footer class="sitefoot">
  <div class="inner">
    <div class="foot-grid">
      <div class="foot-brand">
        ${renderLandingLogo("foot")}
        <p>Pre-payment trust checks for autonomous agent commerce via x402. Deciding whether to pay, before you pay.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1.5rem;">
        <div class="foot-col">
          <h4>Product</h4>
          <ul>
            <li><a href="#features">Features</a></li>
            <li><a href="#how-it-works">How It Works</a></li>
            <li><a href="#integrate">Integrate</a></li>
          </ul>
        </div>
        <div class="foot-col">
          <h4>Developers</h4>
          <ul>
            <li><a href="/auth.md">Docs</a></li>
            <li><a href="https://mcp.gradientdecisions.com/mcp">MCP Endpoint</a></li>
            <li><a href="/.well-known/api-catalog">API Catalog</a></li>
          </ul>
        </div>
        <div class="foot-col">
          <h4>Legal</h4>
          <ul>
            <li><a href="/privacy">Privacy Policy</a></li>
          </ul>
        </div>
      </div>
    </div>
    <div class="foot-bottom">
      <span>© 2026 Gradient Decisions. Built for autonomous agent commerce.</span>
      <a href="/privacy">Privacy policy</a>
    </div>
  </div>
</footer>`;
}
