const test = require("node:test");
const assert = require("node:assert/strict");
const { messageKey, addMessage, missingMessageIds } = require("../message-matcher.js");

function groups(messages) {
  const result = new Map();
  for (const message of messages) addMessage(result, message);
  return result;
}

test("matches messages without Message-ID by stable metadata", () => {
  const source = { id: 1, date: new Date("2026-01-02T03:04:05Z"), subject: "Hello", author: "A@example.com", recipients: ["B@example.com"], size: 42 };
  const copy = { ...source, id: 99, author: "a@example.com", recipients: ["b@example.com"] };
  assert.equal(messageKey(source), messageKey(copy));
  assert.deepEqual(missingMessageIds(groups([source]), groups([copy])), []);
});

test("copies only the surplus occurrence for duplicate Message-IDs", () => {
  const source = [
    { id: 1, headerMessageId: "<same@example.com>" },
    { id: 2, headerMessageId: "<same@example.com>" },
  ];
  const destination = [{ id: 3, headerMessageId: "<same@example.com>" }];
  assert.deepEqual(missingMessageIds(groups(source), groups(destination)), [2]);
});

test("handles mixed folders and normalizes Message-IDs", () => {
  const existing = { id: 1, headerMessageId: " <ONE@example.com> " };
  const duplicate = { id: 2, headerMessageId: "<one@example.com>" };
  const withoutId = { id: 3, date: "2026-02-03T04:05:06Z", subject: "No id", author: "sender@example.com", size: 100 };
  assert.deepEqual(missingMessageIds(groups([existing, withoutId]), groups([duplicate])), [3]);
});
