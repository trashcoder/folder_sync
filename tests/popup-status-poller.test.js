const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const StatusPoller = require("../popup/status-poller.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        now = task.at;
        task.callback();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
    pendingCount() { return tasks.size; },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("a poll slower than its interval never overlaps or queues another poll", async () => {
  const timers = fakeTimers();
  const runs = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const poller = StatusPoller.create(() => {
    const run = deferred();
    runs.push(run);
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    return run.promise.finally(() => { concurrent -= 1; });
  }, 10, timers);

  poller.start();
  await timers.advance(10);
  assert.equal(runs.length, 1);

  await timers.advance(50);
  assert.equal(runs.length, 1, "elapsed intervals must not queue while a poll is running");
  assert.equal(timers.pendingCount(), 0);

  runs[0].resolve();
  await flushMicrotasks();
  await timers.advance(9);
  assert.equal(runs.length, 1);
  await timers.advance(1);
  assert.equal(runs.length, 2);
  assert.equal(maximumConcurrent, 1);

  poller.stop();
  runs[1].resolve();
  await flushMicrotasks();
  assert.equal(timers.pendingCount(), 0);
});

test("popup polling refreshes status only and loads the poller before popup code", () => {
  const popupSource = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const refreshBody = popupSource.match(/async function refreshSyncStatuses\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(refreshBody, /action: "getStatus"/);
  assert.doesNotMatch(refreshBody, /getConfigs|renderSyncList/);
  assert.ok(html.indexOf('src="status-poller.js"') < html.indexOf('src="popup.js"'));
});

test("popup stores specialUse metadata instead of the removed MailFolder type", () => {
  const popupSource = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");

  assert.match(popupSource, /dataset\.folderSpecialUse/);
  assert.match(popupSource, /specialUse:/);
  assert.doesNotMatch(popupSource, /dataset\.folderType|folder\.type/);
});
