(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StatusPoller = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function create(poll, intervalMs, timers = globalThis) {
    let active = false;
    let timer = null;
    let inFlight = null;

    function schedule() {
      if (!active || timer !== null || inFlight) return;
      timer = timers.setTimeout(run, intervalMs);
    }

    async function run() {
      timer = null;
      if (!active || inFlight) return;

      inFlight = Promise.resolve().then(poll);
      try {
        await inFlight;
      } catch {
        // A transient popup/background error must not stop future status updates.
      } finally {
        inFlight = null;
        schedule();
      }
    }

    function start() {
      active = true;
      schedule();
    }

    function stop() {
      active = false;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    }

    return { start, stop };
  }

  return { create };
});
