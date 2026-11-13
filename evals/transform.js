// Map the app's JSON-mode response to a Promptfoo provider response.
// output = the answer text (what graders read); metadata = route, timings, citations, verification.
module.exports = (json) => {
  if (!json || typeof json !== "object") return { output: String(json) };
  if (json.error) return { output: `ERROR: ${json.error.message ?? json.error}`, metadata: { error: true } };
  const d = json.done ?? {};
  return {
    output: json.text ?? "",
    metadata: {
      route: d.route,
      ttftMs: d.timings?.ttftMs,
      totalMs: d.timings?.totalMs,
      searches: d.search?.calls ?? 0,
      invalidCitations: d.citations?.invalid ?? [],
      citationsUsed: d.citations?.used ?? 0,
      verification: json.verification?.summary ?? null,
      verifier: json.verification?.verifier ?? null,
      sourceCount: Array.isArray(json.sources) ? json.sources.length : 0,
      memory: json.memory ?? [],
      models: d.models,
      notice: json.notice?.text ?? null,
    },
  };
};
