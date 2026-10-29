/**
 * Server-side Gemini abstraction. The API key is read from server config only and is sent in a header
 * (never in a URL, never logged, never returned to clients). `fetchImpl` is injectable for tests.
 */
export function geminiAvailable(config) {
  return Boolean(config.gemini.apiKey);
}

export async function geminiJson({ config, fetchImpl = fetch, system, prompt }) {
  if (!geminiAvailable(config)) throw new Error('gemini_not_configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.gemini.timeoutMs);
  try {
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) throw new Error(`gemini_http_${res.status}`);
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) throw new Error('gemini_empty_response');
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('gemini_timeout');
    if (e instanceof SyntaxError) throw new Error('gemini_invalid_json');
    // Only our own coded messages are forwarded; raw network/library errors may contain secrets.
    const msg = String(e.message || '');
    throw new Error(/^gemini_[a-z0-9_]+$/.test(msg) ? msg : 'gemini_network_error');
  } finally {
    clearTimeout(timer);
  }
}
