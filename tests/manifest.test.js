const assert = require("node:assert/strict");
const test = require("node:test");
const manifest = require("../manifest.json");

test("requests only the account permission needed to read folders", () => {
  assert.ok(manifest.permissions.includes("accountsRead"));
  assert.ok(!manifest.permissions.includes("accountsFolders"));
});

test("declares release 0.3.0", () => {
  assert.equal(manifest.version, "0.3.0");
});
