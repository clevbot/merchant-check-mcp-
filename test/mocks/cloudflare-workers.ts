/**
 * Minimal stand-in for the `cloudflare:workers` built-in module, aliased
 * in for the plain-Node test runner (see vitest.config.ts's own comment
 * on why this suite deliberately doesn't use @cloudflare/vitest-pool-workers
 * / real workerd). Only `tracing.enterSpan` is actually used in src/ (see
 * src/tool.ts, src/categorize/model.ts) — this just runs the callback
 * with a no-op span so those modules import cleanly under Node, without
 * pulling in a real Workers runtime for tests that don't exercise tracing
 * behavior itself.
 */
class FakeSpan {
  get isTraced(): boolean {
    return false;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  end(): void {}
}

export const tracing = {
  enterSpan<T>(_name: string, callback: (span: FakeSpan) => T): T {
    return callback(new FakeSpan());
  },
  startActiveSpan<T>(_name: string, callback: (span: FakeSpan) => T): T {
    return callback(new FakeSpan());
  },
  startSpan(): FakeSpan {
    return new FakeSpan();
  },
  Span: FakeSpan,
};
