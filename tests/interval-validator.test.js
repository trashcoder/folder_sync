const test = require("node:test");
const assert = require("node:assert/strict");
const IntervalValidator = require("../interval-validator.js");

test("accepts the interval boundaries", () => {
  assert.equal(IntervalValidator.isValid(1), true);
  assert.equal(IntervalValidator.isValid(1440), true);
});

test("rejects values outside the interval boundaries", () => {
  assert.equal(IntervalValidator.isValid(0), false);
  assert.equal(IntervalValidator.isValid(-1), false);
  assert.equal(IntervalValidator.isValid(1441), false);
});

test("rejects empty, decimal, non-numeric, and numeric string values", () => {
  for (const value of ["", 1.5, NaN, "five", "5", null, undefined]) {
    assert.equal(IntervalValidator.isValid(value), false, `expected ${String(value)} to be rejected`);
    assert.throws(() => IntervalValidator.assertValid(value), RangeError);
  }
});
