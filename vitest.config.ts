import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Plain Node test runner, not @cloudflare/vitest-pool-workers — the
// functions under test (src/scoring.ts, src/chains.ts, src/tool.ts's
// pure helpers) don't touch Workers-specific bindings directly; checkMerchant
// itself is tested against a hand-written fake D1Database (see
// test/tool.test.ts), not a real Workers runtime. Keeps the test suite
// fast and dependency-light rather than pulling in workerd for pure-function
// coverage that doesn't need it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // src/tool.ts and src/categorize/model.ts import `tracing` from
      // this Workers-runtime-only built-in (2026-08-19, agent tracing —
      // see wrangler.toml's [observability.traces] comment). Plain Node
      // can't resolve it at all, so it's aliased to a no-op mock rather
      // than pulling in real workerd just to make an import resolve for
      // tests that don't exercise tracing behavior — see that mock's own
      // comment.
      "cloudflare:workers": fileURLToPath(new URL("./test/mocks/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
