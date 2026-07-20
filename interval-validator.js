(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IntervalValidator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MIN_MINUTES = 1;
  const MAX_MINUTES = 1440;

  function isValid(value) {
    return typeof value === "number" && Number.isInteger(value) &&
      value >= MIN_MINUTES && value <= MAX_MINUTES;
  }

  function assertValid(value) {
    if (!isValid(value)) {
      throw new RangeError(`Auto-sync interval must be an integer from ${MIN_MINUTES} to ${MAX_MINUTES} minutes`);
    }
    return value;
  }

  return { MIN_MINUTES, MAX_MINUTES, isValid, assertValid };
});
