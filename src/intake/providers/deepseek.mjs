import { providerError, tokenUsage } from '../llm-provider.mjs';

/** First LLMProvider implementation. Only this boundary knows DeepSeek wire fields. */
export function createDeepSeekProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = env.DEEPSEEK_API_KEY;
  const model = env.DEEPSEEK_MODEL;
  let endpoint;
  try {
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) ||
        typeof model !== 'string' || !model.trim() || typeof fetchImpl !== 'function') throw new Error();
    const base = new URL(env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
    base.pathname = base.pathname.replace(/\/+$/u, '') + '/chat/completions';
    endpoint = base.href;
  } catch { throw providerError('PROVIDER_CONFIG_ERROR', 0); }

  return {
    async generateJson({ messages, signal }) {
      if (!signal || signal.aborted) throw providerError('MODEL_ERROR', 0);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false,
            response_format: { type: 'json_object' }, tool_choice: 'none' }),
        });
      } catch { throw providerError('MODEL_ERROR', 1); }
      // Never copy upstream error text, request objects, headers or reasoning into errors.
      if (!response.ok) throw providerError('MODEL_ERROR', 1);
      let body;
      try { body = await response.json(); }
      catch { throw providerError(signal.aborted ? 'MODEL_ERROR' : 'INVALID_OUTPUT', 1); }
      if (signal.aborted) throw providerError('MODEL_ERROR', 1);
      if (!Array.isArray(body?.choices) || body.choices.length !== 1) throw providerError('INVALID_OUTPUT', 1);
      const choice = body.choices[0];
      const message = choice?.message;
      if (message?.tool_calls != null || message?.function_call != null || choice?.finish_reason === 'tool_calls') {
        throw providerError('UNSAFE_TOOL_USE', 1);
      }
      if (choice?.finish_reason !== 'stop' || typeof message?.content !== 'string' || !message.content.trim()) {
        throw providerError('INVALID_OUTPUT', 1);
      }
      if (message.content.includes(key)) throw providerError('INVALID_OUTPUT', 1);
      return { text: message.content, usage: tokenUsage(body.usage), llm_requests: 1 };
    },
  };
}
