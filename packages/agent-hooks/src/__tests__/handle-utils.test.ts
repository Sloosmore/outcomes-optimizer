import { describe, it, expect } from "vitest";
import { evaluateCondition, HandlerConfigSchema } from "../commands/handle-utils.js";

describe("evaluateCondition", () => {
  it("evaluates > operator", () => {
    expect(evaluateCondition({ score: 50 }, "score > 40")).toBe(true);
    expect(evaluateCondition({ score: 30 }, "score > 40")).toBe(false);
  });

  it("evaluates >= operator", () => {
    expect(evaluateCondition({ score: 40 }, "score >= 40")).toBe(true);
    expect(evaluateCondition({ score: 39 }, "score >= 40")).toBe(false);
  });

  it("evaluates < operator", () => {
    expect(evaluateCondition({ score: 30 }, "score < 40")).toBe(true);
    expect(evaluateCondition({ score: 50 }, "score < 40")).toBe(false);
  });

  it("evaluates <= operator", () => {
    expect(evaluateCondition({ score: 40 }, "score <= 40")).toBe(true);
    expect(evaluateCondition({ score: 41 }, "score <= 40")).toBe(false);
  });

  it("evaluates == operator (string comparison)", () => {
    expect(evaluateCondition({ status: "active" }, "status == active")).toBe(true);
    expect(evaluateCondition({ status: "inactive" }, "status == active")).toBe(false);
    expect(evaluateCondition({ count: 42 }, "count == 42")).toBe(true);
  });

  it("evaluates != operator (string comparison)", () => {
    expect(evaluateCondition({ status: "active" }, "status != inactive")).toBe(true);
    expect(evaluateCondition({ status: "active" }, "status != active")).toBe(false);
  });

  it("resolves deep dot-notation paths", () => {
    const payload = { engagement: { views: 15000 } };
    expect(evaluateCondition(payload, "engagement.views > 10000")).toBe(true);
    expect(evaluateCondition(payload, "engagement.views < 10000")).toBe(false);
  });

  it("strips payload. prefix from path", () => {
    const payload = { engagement: { views: 15000 } };
    expect(evaluateCondition(payload, "payload.engagement.views > 10000")).toBe(true);
  });

  it("returns false for missing path", () => {
    expect(evaluateCondition({}, "nonexistent > 10")).toBe(false);
    expect(evaluateCondition({ a: {} }, "a.b.c > 10")).toBe(false);
  });

  it("returns false for null intermediate", () => {
    expect(evaluateCondition({ a: null }, "a.b > 10")).toBe(false);
  });

  it("returns false for unparseable numeric value", () => {
    expect(evaluateCondition({ score: "abc" }, "score > 10")).toBe(false);
  });

  it("returns false for NaN result", () => {
    expect(evaluateCondition({ score: NaN }, "score > 10")).toBe(false);
  });

  it("handles string equality with ==", () => {
    expect(evaluateCondition({ type: "webhook" }, "type == webhook")).toBe(true);
    expect(evaluateCondition({ type: "webhook" }, "type == email")).toBe(false);
  });

  it("handles string inequality with !=", () => {
    expect(evaluateCondition({ type: "webhook" }, "type != email")).toBe(true);
    expect(evaluateCondition({ type: "webhook" }, "type != webhook")).toBe(false);
  });

  it("rejects __proto__ traversal", () => {
    expect(evaluateCondition({}, "__proto__.toString == function")).toBe(false);
  });

  it("rejects constructor traversal", () => {
    expect(evaluateCondition({}, "constructor.name == Object")).toBe(false);
  });

  it("rejects prototype traversal", () => {
    expect(evaluateCondition({}, "prototype.toString == function")).toBe(false);
  });
});

describe("HandlerConfigSchema", () => {
  it("accepts minimal valid config with ai_response", () => {
    const result = HandlerConfigSchema.safeParse({ handler_type: "ai_response" });
    expect(result.success).toBe(true);
  });

  it("accepts minimal valid config with start_epoch", () => {
    const result = HandlerConfigSchema.safeParse({ handler_type: "start_epoch" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown handler_type", () => {
    const result = HandlerConfigSchema.safeParse({ handler_type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("rejects missing handler_type", () => {
    const result = HandlerConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts all optional fields present", () => {
    const result = HandlerConfigSchema.safeParse({
      handler_type: "ai_response",
      model: "claude-opus-4-7",
      tools: ["search", "browse"],
      rate_limit_per_hour: 100,
      max_budget_usd: 5.0,
      timeout_seconds: 30,
      condition: "payload.score > 50",
      reason: "High engagement detected",
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong field types", () => {
    const result = HandlerConfigSchema.safeParse({
      handler_type: "ai_response",
      rate_limit_per_hour: "not-a-number",
    });
    expect(result.success).toBe(false);
  });
});
