const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const productionScripts = ["background.js", "popup/popup.js"];

test("console diagnostics do not expose account, folder, or error objects", () => {
  for (const script of productionScripts) {
    const source = fs.readFileSync(path.join(__dirname, "..", script), "utf8");
    const diagnostics = source.match(/console\.(?:log|debug|info|warn|error)\([^\n]*\)/g) || [];

    assert.ok(!source.includes("console.log("), `${script} must not contain debug logging`);
    for (const diagnostic of diagnostics) {
      assert.doesNotMatch(
        diagnostic,
        /JSON\.stringify|accountsData|folder\.id|\b(?:err|error)\b\s*[,)]+/,
        `${script} console diagnostics must contain fixed, non-sensitive context only`
      );
    }
  }
});
