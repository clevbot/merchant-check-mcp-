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
});
