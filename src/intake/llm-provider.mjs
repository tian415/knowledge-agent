/**
 * @typedef {{role:'system'|'user', content:string}} LLMMessage
 * @typedef {{generateJson(input:{messages:LLMMessage[], signal:AbortSignal}):
 * Promise<{text:string, usage:Object|null, llm_requests:1}>}} LLMProvider
 * Providers return text, never certified candidates. Call validateCandidates locally
 * after organize(); JSON Output cannot establish evidence or Registry truth.
 * Provider errors expose only safe code/message and client request count (0 or 1).
 */
const messages = Object.freeze({
  MODEL_ERROR: 'LLM request failed or was cancelled.',
  INVALID_OUTPUT: 'LLM output is incomplete or invalid.',
  UNSAFE_TOOL_USE: 'LLM tool use is not allowed.',
  PROVIDER_CONFIG_ERROR: 'LLM provider configuration is invalid.',
  INPUT_TOO_LARGE: 'Complete organizer prompt exceeds the input limit.',
});
export function providerError(code, llm_requests) {
  const safeCode = Object.hasOwn(messages, code) ? code : 'MODEL_ERROR';
  return Object.assign(new Error(messages[safeCode]), { code: safeCode, llm_requests });
}
export function tokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) usage[field] = value[field];
  }
  return Object.keys(usage).length ? usage : null;
}
