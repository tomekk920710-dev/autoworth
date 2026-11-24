import test from "node:test";
import assert from "node:assert/strict";
import { recalculateSavedEconomics } from "../economics.js";

const base = {
  tasks: 1200, mins: 8, labor: 24, ai: 0.08,
  review: 2, reviewRate: 75, errorRate: 0.04, setup: 12000,
  current: 999999, automation: 999999, saving: 999999, payback: 999999
};

test("recalculates support economics from saved inputs, not stale totals", () => {
  const result = recalculateSavedEconomics(base);
  assert.equal(result.ok, true);
  assert.equal(result.economics.current, 3840);
  assert.equal(result.economics.automation, 816);
  assert.equal(result.economics.saving, 2908.8);
  assert.equal(result.economics.payback, 12000 / 2908.8);
  assert.equal(result.economics.ai, 0.08);
});

test("treats reviewRate=1 as one percent, not one hundred percent", () => {
  const result = recalculateSavedEconomics({ ...base, reviewRate: 1, review: 3, tasks: 500, mins: 8, labor: 30, ai: 0.05, errorRate: 0.03, setup: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.economics.reviewRate, 1);
  assert.equal(result.economics.automation, 25 + (500 * 0.01 * 3 / 60 * 30));
});

test("preserves zero percent and one hundred percent review coverage", () => {
  const zero = recalculateSavedEconomics({ ...base, reviewRate: 0 });
  const full = recalculateSavedEconomics({ ...base, reviewRate: 100 });
  assert.equal(zero.economics.automation, 96);
  assert.equal(full.economics.automation, 1056);
});

test("rejects missing or out-of-range required inputs instead of exporting stale totals", () => {
  assert.equal(recalculateSavedEconomics({ ...base, reviewRate: undefined }).ok, false);
  assert.equal(recalculateSavedEconomics({ ...base, reviewRate: 101 }).ok, false);
  assert.equal(recalculateSavedEconomics({ ...base, tasks: 0 }).ok, false);
});

test("accepts legacy errorRate percentage values above one", () => {
  const result = recalculateSavedEconomics({ ...base, errorRate: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.economics.errorRate, 0.04);
});

test("recalculates the invoice-processing reference case exactly", () => {
  const result = recalculateSavedEconomics({
    tasks: 500, mins: 8, labor: 30, ai: 0.05,
    review: 3, reviewRate: 100, errorRate: 0.03, setup: 500
  });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.economics.current - 2000) < 1e-9);
  assert.ok(Math.abs(result.economics.automation - 775) < 1e-9);
  assert.ok(Math.abs(result.economics.saving - 1180) < 1e-9);
  assert.ok(Math.abs(result.economics.payback - 500 / 1180) < 1e-9);
});
