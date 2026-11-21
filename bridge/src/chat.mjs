// bridge/src/chat.mjs — inti chat: menyusun permintaan ke provider dan menormalkan aliran jawabannya.
// Murni (tanpa I/O): `buildRequest` menghasilkan { url, headers, body }; `parseStream` mengubah potongan
// SSE/JSON provider menjadi event seragam: { type: 'text', text } | { type: 'tool', name, input } | { type: 'usage', ... }.
// Satu tempat untuk semua perbedaan bentuk provider — UI dan rute chat tidak menyentuhnya.
import { PROVIDER_KINDS, effortParams, modelsFor } from './providers.mjs';

const baseFor = (provider) => provider.base_url || {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
}[provider.kind];

/**
 * Bangun permintaan chat (streaming) ke provider.
 * @param {object} provider baris provider (kind, base_url, id)
 * @param {string} apiKey
 * @param {{ model: string, effort?: string, system?: string, messages: {role,content}[],
 *   tools?: object[], maxTokens?: number }} opts
 */
export function buildRequest(provider, apiKey, opts) {
  const { model, effort = 'default', messages, system, tools, maxTokens = 4096 } = opts;
  const base = baseFor(provider);
  const extra = effortParams(provider.kind, model, effort);

  if (provider.kind === 'openai') {
    const body = {
      model, stream: true, max_completion_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      ...extra,
    };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    return { url: `${base}/chat/completions`, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body };
  }

  if (provider.kind === 'anthropic') {
    const body = {
      model, stream: true, max_tokens: maxTokens,
      messages: messages.map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content })),
      ...extra,
    };
    if (system) body.system = system;
    if (tools?.length) body.tools = tools.map(anthropicTool);
    return { url: `${base}/messages`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body };
  }

  if (provider.kind === 'google') {
    const body = {
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: maxTokens, ...extra },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools?.length) body.tools = [{ functionDeclarations: tools.map(googleTool) }];
    return { url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, headers: { 'Content-Type': 'application/json' }, body };
  }

  throw new Error(`Provider kind tidak dikenal: ${provider.kind}`);
}

const anthropicTool = (t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters });
const googleTool = (t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters });

/**
 * Parser aliran per provider. Mengembalikan fungsi `push(chunkText)` yang mengembalikan array event.
 * State disimpan di closure; aman dipanggil berkali-kali sampai stream selesai.
 */
export function parseStream(kind) {
  let buf = '';
  if (kind === 'anthropic') {
    const blocks = new Map(); // index → { name, json }
    return (chunk) => {
      buf += chunk;
      const events = [];
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
          blocks.set(j.index, { name: j.content_block.name, json: '' });
        } else if (j.type === 'content_block_delta') {
          if (j.delta?.type === 'text_delta') events.push({ type: 'text', text: j.delta.text });
          if (j.delta?.type === 'input_json_delta') { const b = blocks.get(j.index); if (b) b.json += j.delta.partial_json; }
        } else if (j.type === 'content_block_stop') {
          const b = blocks.get(j.index);
          if (b) { events.push({ type: 'tool', name: b.name, input: safeJson(b.json) }); blocks.delete(j.index); }
        } else if (j.type === 'message_delta' && j.usage) {
          events.push({ type: 'usage', outputTokens: j.usage.output_tokens });
        }
      }
      return events;
    };
  }

  if (kind === 'google') {
    return (chunk) => {
      buf += chunk;
      const events = [];
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        for (const part of j.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) events.push({ type: 'text', text: part.text });
          if (part.functionCall) events.push({ type: 'tool', name: part.functionCall.name, input: part.functionCall.args ?? {} });
        }
        if (j.usageMetadata) events.push({ type: 'usage', outputTokens: j.usageMetadata.candidatesTokenCount });
      }
      return events;
    };
  }

  // openai (default): potongan `data: {...}` dengan choices[].delta.
  const toolAcc = new Map(); // index → { name, args }
  return (chunk) => {
    buf += chunk;
    const events = [];
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) events.push({ type: 'text', text: delta.content });
      for (const call of delta?.tool_calls ?? []) {
        const cur = toolAcc.get(call.index) ?? { name: '', args: '' };
        if (call.function?.name) cur.name = call.function.name;
        if (call.function?.arguments) cur.args += call.function.arguments;
        toolAcc.set(call.index, cur);
      }
      const finish = j.choices?.[0]?.finish_reason;
      if (finish === 'tool_calls') {
        for (const [, cur] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) events.push({ type: 'tool', name: cur.name, input: safeJson(cur.args) });
        toolAcc.clear();
      }
      if (j.usage) events.push({ type: 'usage', outputTokens: j.usage.completion_tokens });
    }
    return events;
  };
}

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/** Batas panjang pesan user (dipakai rute; dites di sini agar konsisten). */
export const MAX_MESSAGE_CHARS = 32_000;
export const messageProblem = (text) => {
  const t = String(text ?? '').trim();
  if (!t) return 'Pesan kosong';
  if (t.length > MAX_MESSAGE_CHARS) return `Pesan terlalu panjang (maksimal ${MAX_MESSAGE_CHARS} karakter)`;
  return null;
};

/** Daftar model yang boleh dipilih untuk sebuah kind (untuk validasi request). */
export const allowedModels = (kind) => modelsFor(kind).map((m) => m.id);

export { PROVIDER_KINDS };