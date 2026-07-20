(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MessageMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item).trim().toLowerCase()).sort();
  }

  function messageKey(message) {
    const headerMessageId = String(message.headerMessageId || "").trim().toLowerCase();
    if (headerMessageId) return `message-id:${headerMessageId}`;

    // Thunderbird does not expose the raw message here. This metadata fingerprint
    // is stable across copies and multiplicity is handled separately below.
    return `fallback:${JSON.stringify({
      date: message.date instanceof Date ? message.date.toISOString() : String(message.date || ""),
      subject: String(message.subject || "").trim(),
      author: String(message.author || "").trim().toLowerCase(),
      recipients: normalizeList(message.recipients),
      ccList: normalizeList(message.ccList),
      bccList: normalizeList(message.bccList),
      size: Number.isFinite(message.size) ? message.size : null,
    })}`;
  }

  function addMessage(groups, message) {
    const key = messageKey(message);
    const ids = groups.get(key) || [];
    ids.push(message.id);
    groups.set(key, ids);
  }

  function missingMessageIds(sourceGroups, destinationGroups) {
    const missing = [];
    for (const [key, sourceIds] of sourceGroups) {
      const destinationCount = destinationGroups.get(key)?.length || 0;
      if (sourceIds.length > destinationCount) {
        missing.push(...sourceIds.slice(destinationCount));
      }
    }
    return missing;
  }

  return { messageKey, addMessage, missingMessageIds };
});
