/**
 * `/methodology` (2026-08-19) — styled webpage in the same visual system as
 * the redesigned homepage (src/homePlaceholder.ts), not a plain markdown
 * dump. First built as markdown-only, then redone here at the user's direct
 * follow-up ("no no just make the methodology another webpage with the
 * same theme etc"). Shares the real nav/footer/fonts/CSS tokens from
 * homePlaceholder.ts (LANDING_STYLES, renderLandingNav, renderLandingFooter,
 * renderLandingLogo, FIGMA_FONT_LINKS) rather than a second copy — see that
 * file's own comments on those exports for why they're factored out.
 *
 * A prose explainer for a human evaluator deciding whether to trust and
 * integrate the product — auth.md stays the protocol-mechanics doc for an
 * integrating agent, unchanged, cross-linked from here. Every number below
 * (0.3 diversity ratio, 50-payer override, 14-day/20-tx/35%-abandon/3x-0.35x
 * price thresholds, the tier/recommendation mapping) is pulled directly
 * from src/scoring.ts and src/tool.ts, not paraphrased from memory. If
 * those files' thresholds change, this page goes stale — there's no
 * shared-constant mechanism forcing the two to match (scoring.ts's
 * constants are internal, not exported for display), so it's on whoever
 * changes scoring.ts next to also update this file's copy.
 */
import { FAVICON_LINK } from "./brand";
import { FIGMA_FONT_LINKS, LANDING_STYLES, renderLandingFooter, renderLandingNav } from "./homePlaceholder";

type SignalStatus = "LIVE" | "DORMANT" | "STUBBED";

interface Signal {
  icon: string;
  status: SignalStatus;
  title: string;
  body: string;
}

const STATUS_BADGE_SLUG: Record<SignalStatus, string> = {
  LIVE: "proceed",
  DORMANT: "insufficient",
  STUBBED: "caution",
};

const SIGNALS: Signal[] = [
  {
    icon: "🕒",
    status: "LIVE",
    title: "1. Wallet age",
    body: "Flags wallets younger than 14 days. A merchant that's only existed for a few days has no track record to speak of, independent of anything else about it.",
  },
  {
    icon: "👥",
    status: "LIVE",
    title: "2. Payer diversity",
    body: "Compares unique payers against total transaction count. Below a 0.3 ratio, volume looks concentrated among very few payers — consistent with wash volume. One override: 50+ distinct payers skips this check regardless of ratio, since a high-frequency-use API naturally drives the ratio down without real concentration risk. Both numbers are calibrated against real production data — the ratio checked against 365 live merchants, the payer floor set comfortably under where real PROCEED-tier merchants top out.",
  },
  {
    icon: "📦",
    status: "DORMANT",
    title: "3. Settlement completion",
    body: "Once live: flags a merchant whose quote→pay→deliver flow gets abandoned more than 35% of the time. Currently dormant on both chains — neither ingested data source populates completed/abandoned flow counts yet.",
  },
  {
    icon: "💸",
    status: "LIVE",
    title: "4. Refund / recourse",
    body: "Flags zero refunds despite meaningful volume (20+ transactions) and nonzero refund-eligible volume. Zero refunds at real volume isn't automatically suspicious, but it's a visible absence of recourse worth surfacing.",
  },
  {
    icon: "🏷️",
    status: "DORMANT",
    title: "5. Price consistency",
    body: "Once live: flags a merchant charging different requesters different prices for the identical resource. Currently dormant on both chains — no ingested source populates per-payer price observations yet.",
  },
  {
    icon: "📈",
    status: "STUBBED",
    title: "6. Velocity / anomaly detection",
    body: "Meant to catch anomalous spikes in volume or transaction size. Not yet implemented on either chain: Solana settles roughly 4x faster than Base, and a threshold tuned on Base activity would over-flag normal Solana usage — this gets implemented chain-aware, not retrofit after the fact.",
  },
];

interface TierStep {
  n: string;
  icon: string;
  title: string;
  body: string;
}

const TIER_STEPS: TierStep[] = [
  { n: "0 signals", icon: "✓", title: "trusted", body: "No findings at all. Also gets one explicit positive reason recorded — not just a bare “nothing wrong found.”" },
  { n: "1 signal", icon: "!", title: "caution", body: "Exactly one finding fired. Worth a closer look, not a hard stop." },
  { n: "2+ signals", icon: "✕", title: "avoid", body: "Two or more findings fired. The strongest tier this pipeline currently produces." },
];

export function renderMethodologyHtml(): string {
  return `<title>Methodology | Gradient Decisions</title>
<meta name="description" content="How check_merchant scores trust — the real signals, thresholds, and tier logic behind PROCEED/CAUTION/INSUFFICIENT SIGNAL.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FIGMA_FONT_LINKS}
${LANDING_STYLES}

${renderLandingNav()}

<div class="gradient-wrap">
<section class="hero" style="padding-top:3.5rem;padding-bottom:3rem;">
  <div class="inner">
    <span class="tag peach">METHODOLOGY</span>
    <h1 style="font-size:clamp(1.9rem,4.5vw,2.8rem);">How check_merchant Scores Trust</h1>
    <p class="lede">
      A rules-based v1 system, not a machine-learning model and not a certification. Every signal below maps to
      something specific and inspectable — nothing here is a black-box number. For payment/auth mechanics instead
      of scoring logic, see <a href="/auth.md" style="text-decoration:underline;">auth.md</a>.
    </p>
  </div>
</section>
</div>

<section class="doc-section">
  <div class="inner prose">
    <div class="section-head">
      <h2>What It's Built From</h2>
    </div>
    <p>
      Only two kinds of data feed this: a merchant wallet's <strong>observable on-chain settlement history</strong>,
      and its <strong>x402 activity</strong> — what it charges, how often it's paid, by how many distinct payers.
      Nothing here is self-reported, manually reviewed, or sourced from off-chain reputation. A merchant can't
      improve its own score by filling out a form.
    </p>
  </div>
</section>

<section class="doc-section" id="signals" style="background:var(--bg-muted);">
  <div class="inner">
    <div class="section-head">
      <h2>The Six Signals</h2>
      <p>Every real finding adds one entry to <code class="mono">reasons</code> and one matching code to <code class="mono">risk_flags</code>. Two of six are currently dormant, one is stubbed — stated plainly here, not glossed over.</p>
    </div>
    <div class="features-grid">
      ${SIGNALS.map(
        (s) => `<div class="feature-card">
        <div class="f-top">
          <div class="f-icon">${s.icon}</div>
          <span class="m-badge m-badge-${STATUS_BADGE_SLUG[s.status]}">${s.status}</span>
        </div>
        <h3>${s.title}</h3>
        <p>${s.body}</p>
      </div>`,
      ).join("\n")}
    </div>
  </div>
</section>

<section class="doc-section">
  <div class="inner">
    <div class="section-head">
      <h2>From Signals To A Tier</h2>
      <p>The rule is a direct count, not a weighted score.</p>
    </div>
    <div class="workflow-grid">
      ${TIER_STEPS.map(
        (t) => `<div class="step-card">
        <span class="step-n">${t.n.toUpperCase()}</span>
        <div class="step-icon">${t.icon}</div>
        <h3>${t.title}</h3>
        <p>${t.body}</p>
      </div>`,
      ).join("\n")}
    </div>
  </div>
</section>

<section class="doc-section" style="background:var(--bg-muted);">
  <div class="inner prose">
    <div class="section-head">
      <h2>From Tier To Recommendation</h2>
      <p><code class="mono">trust_tier</code> (TRUSTED/CAUTION/AVOID) is the detailed read; <code class="mono">recommendation</code> (PROCEED/CAUTION/INSUFFICIENT_SIGNAL) is the smaller, deterministic vocabulary an agent's payment policy is meant to switch on directly. They're not the same axis:</p>
    </div>
    <ul class="checklist">
      <li>Fewer than 5 transactions total → <strong>INSUFFICIENT_SIGNAL</strong>, regardless of tier — a data gap, not a behavioral finding.</li>
      <li>5+ transactions, tier is trusted → <strong>PROCEED</strong>.</li>
      <li>5+ transactions, tier is caution or avoid → <strong>CAUTION</strong>.</li>
    </ul>
    <p style="margin-top:1.5rem;color:var(--text-dim);font-size:.9rem;">
      There's no REJECT or BLOCK value. Nothing in this pipeline currently produces evidence strong enough to justify a hard block — adding one without that evidence would just be a stronger-sounding guess than the data supports.
    </p>
  </div>
</section>

<section class="doc-section">
  <div class="inner prose">
    <div class="section-head">
      <h2>Confidence &amp; Payer Concentration</h2>
    </div>
    <p>
      <code class="mono">confidence</code> is graduated separately from the sufficiency gate above: <strong>HIGH</strong>
      at 50+ transactions, <strong>MEDIUM</strong> at 15+, <strong>LOW</strong> below that. A wallet can clear the
      5-transaction sufficiency bar and still only warrant LOW confidence.
    </p>
    <p>
      <code class="mono">payer_concentration</code> (LOW/MEDIUM/HIGH) is derived from the same diversity ratio and
      50-payer override as signal 2 above — deliberately reusing the identical numbers, so this field can never say
      HIGH concentration while <code class="mono">risk_flags</code> stays silent on it.
    </p>
  </div>
</section>

<section class="doc-section" style="background:var(--bg-muted);">
  <div class="inner prose">
    <div class="section-head">
      <h2>Price Fairness</h2>
    </div>
    <p>
      When a caller supplies a price (or the merchant has its own advertised price on file), it's compared against
      the median of comparable prices from other merchants in the same category. Fewer than 3 comparable prices
      returns <strong>unknown</strong> rather than a forced answer.
    </p>
    <ul class="dash-list" style="margin-top:1rem;">
      <li><strong>high</strong> — 3x the category median or more</li>
      <li><strong>low</strong> — 0.35x the category median or less</li>
      <li><strong>fair</strong> — everything in between</li>
    </ul>
    <p style="margin-top:1.5rem;color:var(--text-dim);font-size:.9rem;">
      These bands come from real observed spread across six categories and roughly 400 priced merchants, not an
      arbitrary percentage — categories like "data_api" bundle genuinely different resources at genuinely different
      price points, so the bands are wider than a single-product market would need.
    </p>
  </div>
</section>

<section class="doc-section">
  <div class="inner prose">
    <div class="section-head">
      <h2>Known Limitations</h2>
      <p>Stated plainly, not buried.</p>
    </div>
    <ul class="dash-list">
      <li>Two of the six signals (settlement completion, price consistency) are currently dormant on both chains — no ingested data source populates them yet.</li>
      <li>The velocity/anomaly signal is stubbed entirely, and will need chain-specific tuning before it's safe to enable.</li>
      <li>The payer-diversity ratio and its 50-payer override are calibrated against real Base data only; Solana's own payer-diversity distribution hasn't yet been separately validated.</li>
      <li>Category price-fairness bands are grounded in real data but still coarse — six categories cover a wide range of actual resource types.</li>
    </ul>
    <p style="margin-top:1.5rem;">
      None of this is a certification of any merchant's legitimacy. It's an algorithmic read of public, observable
      signals — decision support for an agent's own payment policy, not a substitute for it.
    </p>
  </div>
</section>

${renderLandingFooter()}`;
}
