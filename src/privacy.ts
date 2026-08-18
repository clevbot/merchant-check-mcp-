/**
 * Privacy policy page, served at GET /privacy (see src/index.ts). Kept as
 * its own file (not inlined into index.ts or dashboard.ts) so the policy
 * text itself is easy to find and update independently of routing/other
 * page logic.
 *
 * Drafted 2026-08-13 by Claude at the user's explicit request ("draft a
 * comprehensive privacy policy yourself"), grounded in this system's real,
 * built data practices — not generic boilerplate copied from elsewhere.
 * IMPORTANT CAVEAT, stated here and to the user directly: this is not a
 * substitute for review by a lawyer. It accurately describes what the code
 * actually does as of LAST_UPDATED, but a live product handling real
 * payments should have this reviewed for the jurisdictions its users are
 * actually in (GDPR/CCPA/etc.) before being treated as final.
 *
 * CONTACT_EMAIL is currently the developer's personal address (the only
 * real email available in this session's context) — swap for a dedicated
 * address (e.g. privacy@gradientdecisions.com) if/when one exists; see
 * README "Privacy policy".
 */

import { BRAND_CSS, FAVICON_LINK, FONT_LINKS, renderMonogram, renderWordmark } from "./brand";

export const LAST_UPDATED = "2026-08-13";
export const CONTACT_EMAIL = "colin.cleven@gmail.com";

export function renderPrivacyPolicyHtml(): string {
  return `<title>Privacy Policy — Gradient Decisions</title>
<meta name="description" content="How Gradient Decisions handles data for x402 Merchant Check.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280; --accent: #4f46e5;
    /* Monochrome fade (same treatment as the actual logo's letterform fade,
       see src/brand.ts), not an invented color gradient — see
       src/dashboard.ts's matching comment for the full reasoning. */
    --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af; --accent: #818cf8;
      --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    line-height: 1.6;
  }
  ${BRAND_CSS}
  .wrap { max-width: 680px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  .topbar { height: 3px; background: var(--brand-gradient); margin: -2.5rem -1.5rem 2rem; }
  .brand-row { display: flex; align-items: center; gap: .65rem; margin-bottom: .6rem; }
  .brand-row .brand-mark { width: 28px; }
  .brand-row .brand-sub { font-size: .74rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em; }
  h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .updated { color: var(--text-dim); font-size: .85rem; margin-bottom: 2rem; }
  h2 { font-size: 1.05rem; font-weight: 600; margin: 2rem 0 .75rem; }
  p, li { font-size: .92rem; }
  ol, ul { padding-left: 1.3rem; }
  a { color: var(--accent); }
  code { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: .1rem .35rem; font-size: .85rem; }
  table { width: 100%; border-collapse: collapse; margin: .75rem 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--border); font-size: .85rem; }
  th { color: var(--text-dim); font-weight: 600; }
  .caveat {
    margin-top: 2.5rem; padding: 1rem 1.1rem; border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface); color: var(--text-dim); font-size: .82rem; font-style: italic;
  }
  footer { margin-top: 2.5rem; color: var(--text-dim); font-size: .82rem; }
  .footer-brand { opacity: .55; margin-bottom: .85rem; }
  footer a { color: var(--accent); }
</style>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand-row">
    ${renderMonogram("privacy-header", 28)}
    <span class="brand-sub">Gradient Decisions</span>
  </div>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: ${LAST_UPDATED}</p>

  <p>
    This policy describes how <strong>Gradient Decisions</strong> ("we", "us") handles data in
    connection with <strong>x402 Merchant Check</strong> — the <code>check_merchant</code> MCP tool at
    <code>mcp.gradientdecisions.com</code> and the public dashboard at
    <code>gradientdecisions.com</code>. It's written to describe what this system actually does,
    not generic boilerplate.
  </p>

  <h2>What this service is</h2>
  <p>
    x402 Merchant Check is a pre-payment decision tool for autonomous agents: before paying an
    unfamiliar merchant via the x402 protocol, an agent can call <code>check_merchant</code> with a
    wallet address and receive an assessment of that merchant's observable on-chain payment
    behavior. The merchant data behind this is aggregated from public blockchain activity and
    public discovery feeds (Coinbase's x402 Bazaar, PayAI Network, Helius) — not collected from
    individuals.
  </p>

  <h2>Data we collect</h2>
  <p>
    <strong>We do not have user accounts.</strong> There is no sign-up, login, password, or email
    collection anywhere in this service. There are no cookies, no tracking pixels, and no
    third-party advertising trackers. What we do collect:
  </p>
  <ol>
    <li>
      <strong>Merchant wallet data</strong> — for every merchant wallet address we've indexed
      (Base or Solana): its transaction count, unique-payer count, advertised prices, category,
      and known platform/service URLs. This is public on-chain and public-discovery-feed data
      about <em>merchants</em>, not about the people calling this service.
    </li>
    <li>
      <strong>Caller wallet data</strong> — when a wallet pays to call <code>check_merchant</code>,
      we log: the paying wallet's address, the merchant wallet it checked, the on-chain payment
      transaction hash, the category/price if supplied, and a timestamp. This lets us track usage
      of the service and, in aggregate, understand who's using it and how often.
    </li>
  </ol>
  <p>
    <strong>We never attempt to link a wallet address to any off-chain identity</strong> — a name,
    an email address, an IP-derived identity, or any other real-world identifier. This is a
    deliberate design principle applied consistently throughout this system, not just a policy
    statement: nothing in our code performs or attempts identity resolution.
  </p>
  <p>
    <strong>Infrastructure-level logging.</strong> This service runs on Cloudflare Workers.
    Cloudflare, as our hosting/CDN provider, processes standard technical request data (e.g. IP
    addresses, request metadata) as part of operating its network — this is typical of any
    Cloudflare-hosted service and is governed by Cloudflare's own role as an infrastructure
    provider, not data we separately collect or store ourselves beyond what's described above.
  </p>

  <h2>How we use this data</h2>
  <ul>
    <li>Merchant wallet data is used to compute and serve the trust/pricing assessment that
      <code>check_merchant</code> returns, and to populate the public dashboard.</li>
    <li>Caller wallet data is used to operate and improve the service: usage and revenue
      visibility, understanding call patterns (e.g. distinguishing one-off callers from
      repeat/active agents), and category-level demand signals. This may inform future product
      decisions about how the service is organized or priced. It is not used to build profiles
      of, or make decisions about, any individual person, because we don't know who is behind any
      given wallet address.</li>
  </ul>

  <h2>Payment processing</h2>
  <p>
    Payments are made via the x402 protocol in USDC on Base mainnet. Payment verification and
    settlement is performed by Coinbase's CDP facilitator infrastructure, not by us directly — we
    receive and store the resulting on-chain transaction hash as proof of payment, which is itself
    public blockchain data.
  </p>

  <h2>Data sharing</h2>
  <p>
    We do not sell wallet-level data. We do not share caller wallet data with third parties for
    advertising or marketing purposes. We do pull <em>from</em> public third-party data sources to
    build merchant assessments (Coinbase's x402 Bazaar, PayAI Network, Helius) — this is data we
    read, not data we send about our users.
  </p>

  <h2>Data retention</h2>
  <p>
    We do not currently run an automated data-deletion or expiry process. Data we've collected is
    retained indefinitely unless removed on request (see "Your rights" below) or as our practices
    evolve. Because wallet addresses and transaction hashes are inherently public blockchain data,
    removing a record from our own database does not remove the underlying on-chain transaction
    itself, which remains publicly visible on the relevant blockchain regardless of what we do.
  </p>

  <h2>Your rights</h2>
  <p>
    Because we don't collect off-chain identity and don't operate accounts, we have no way to
    independently verify that a request relates to "your" wallet versus anyone else's — requests
    are handled on a best-effort, case-by-case basis. If you'd like us to look into or remove data
    associated with a specific wallet address from our own systems, contact us at the address below
    with the wallet address in question. We'll respond and do what we reasonably can, with the
    caveat above about on-chain data being independently public regardless of what we do on our
    end.
  </p>
  <p>
    If you are located in a jurisdiction with specific statutory rights over personal data (e.g.
    GDPR in the EU/UK, CCPA in California), we intend to honor requests consistent with those
    rights to the extent they apply to the limited, wallet-address-level data described in this
    policy — contact us and we'll work through it with you.
  </p>

  <h2>Children's privacy</h2>
  <p>
    This service is not directed at children, is not marketed to children, and we do not
    knowingly collect data about children. Given the nature of the service (a paid,
    machine-to-machine tool called by autonomous agents over MCP), we don't expect or intend for
    it to be used by children directly.
  </p>

  <h2>Changes to this policy</h2>
  <p>
    We may update this policy as the service changes. Material changes will update the "Last
    updated" date above. Continued use of the service after a change constitutes acceptance of the
    updated policy.
  </p>

  <h2>Contact</h2>
  <p>
    Questions about this policy, or requests regarding data associated with a specific wallet
    address, can be sent to: <strong><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></strong>
  </p>

  <p class="caveat">
    This policy was drafted to accurately describe this system's real, built data practices as of
    the date above. It has not been reviewed by a lawyer. If you are relying on this policy for
    regulatory compliance purposes, we recommend having it reviewed by counsel familiar with the
    jurisdictions your users are in.
  </p>

  <footer>
    <div class="footer-brand">${renderWordmark("privacy-footer", 120)}</div>
    <a href="/">Back to dashboard</a>.
  </footer>
</div>`;
}
