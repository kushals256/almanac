// The simulated user sends the conversation as a chat-message array; the agent keeps its own
// history server-side by sessionId, so only the latest user message is sent (stateful mode).
module.exports = (prompt) => {
  let p = prompt;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { return prompt; }
  }
  if (Array.isArray(p)) {
    const last = [...p].reverse().find((m) => m && m.role === "user");
    return last ? String(last.content) : String(p[p.length - 1]?.content ?? "");
  }
  return typeof p === "string" ? p : JSON.stringify(p);
};
