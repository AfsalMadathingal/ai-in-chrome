// Side-panel chats with a local model served by Ollama (https://ollama.com). Unlike Claude Code / Codex,
// Ollama is only a model server, so the agent loop lives here: stream a reply, run the browser tools it
// asks for (after the side panel approves them), feed the results back, repeat until it answers.
import { TOOLS } from './tools.js';
import { callTool } from './client.js';

export const OLLAMA_URL = (process.env.OLLAMA_HOST && !/^https?:/.test(process.env.OLLAMA_HOST)
  ? `http://${process.env.OLLAMA_HOST}`
  : process.env.OLLAMA_HOST) || 'http://127.0.0.1:11434';

// A focused tool set: small local models do better with fewer, simpler choices.
const OLLAMA_TOOLS = [
  'tabs_context', 'tabs_create', 'tabs_select', 'navigate', 'computer', 'read_page', 'find', 'form_input',
  'get_page_text', 'javascript_tool', 'read_console_messages', 'read_network_requests', 'network_request',
];
const MAX_STEPS = 40; // tool rounds per message
const MAX_RESULT = 8000; // characters of a tool result sent back to the model
const NUM_CTX = 16384;

const baseUrl = (url) => (url || OLLAMA_URL).replace(/\/+$/, '');

// Installed models, or null when Ollama isn't running.
export async function ollamaModels(url) {
  try {
    const res = await fetch(`${baseUrl(url)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || []).map((m) => m.name).sort();
  } catch {
    return null;
  }
}

function toolSchemas() {
  return TOOLS.filter((t) => OLLAMA_TOOLS.includes(t.name)).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function truncate(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// One streamed /api/chat call. Returns the assistant message (content, thinking, tool_calls) and stats.
async function chatOnce(s, { emit, signal }) {
  const body = {
    model: s.model,
    messages: s.messages,
    tools: toolSchemas(),
    stream: true,
    options: { num_ctx: NUM_CTX },
  };
  if (s.think !== false) body.think = true;
  let res = await fetch(`${baseUrl(s.url)}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    // Models without a thinking mode reject `think`: remember that and retry without it.
    if (body.think && /think/i.test(err)) {
      s.think = false;
      delete body.think;
      res = await fetch(`${baseUrl(s.url)}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal });
    } else throw new Error(ollamaError(res.status, err, s.model));
    if (!res.ok) throw new Error(ollamaError(res.status, await res.text().catch(() => ''), s.model));
  }

  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  let stats = {};
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      const part = m.message || {};
      if (part.thinking) {
        msg.thinking += part.thinking;
        emit({ t: 'thinking', text: part.thinking });
      }
      if (part.content) {
        msg.content += part.content;
        emit({ t: 'delta', text: part.content });
      }
      if (part.tool_calls?.length) msg.tool_calls.push(...part.tool_calls);
      if (m.done) stats = m;
    }
  }
  return { msg, stats };
}

function ollamaError(status, text, model) {
  let detail = text;
  try {
    detail = JSON.parse(text).error || text;
  } catch {}
  if (status === 404) return `Model "${model}" isn't installed in Ollama. Run: ollama pull ${model}`;
  if (/does not support tools/i.test(detail)) return `"${model}" can't use tools, so it can't control the browser. Try a tool-capable model such as qwen3, llama3.1 or gpt-oss.`;
  return `Ollama error ${status}: ${detail}`;
}

// Ask the side panel (same rules as Claude Code: read-only tools pass, others may prompt the user).
async function approved(s, name, args) {
  const res = await callTool('approve_action', { sid: s.sid, mode: s.mode, tool_name: `mcp__ai-in-chrome__${name}`, input: args }, { timeoutMs: 330000 });
  const verdict = JSON.parse(res.text || '{}');
  return verdict.behavior === 'allow' ? { ok: true } : { ok: false, message: verdict.message || 'Denied.' };
}

// Run one user message to completion. `emit` sends panel events; `signal` aborts (Stop).
export async function runOllamaTurn(s, text, images, { emit, signal, systemPrompt }) {
  if (!s.model) throw new Error('Pick an Ollama model in Settings (for example qwen3 or llama3.1).');
  if (!s.messages) s.messages = [{ role: 'system', content: `${systemPrompt}\nCall one tool at a time and wait for its result. When the task is done, answer in plain text without calling tools.` }];
  const user = { role: 'user', content: text };
  if (images?.length) user.images = images.map((i) => i.data);
  s.messages.push(user);
  emit({ t: 'session', id: s.sid, model: s.model, agent: 'ollama' });

  const started = Date.now();
  let tokens = 0;
  let steps = 0;
  for (;;) {
    const { msg, stats } = await chatOnce(s, { emit, signal });
    tokens += (stats.prompt_eval_count || 0) + (stats.eval_count || 0);
    const stored = { role: 'assistant', content: msg.content };
    if (msg.tool_calls.length) stored.tool_calls = msg.tool_calls;
    s.messages.push(stored);
    if (msg.content) emit({ t: 'text', text: msg.content });
    if (!msg.tool_calls.length) break;

    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args = call.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const id = `o${Date.now()}-${++steps}`;
      emit({ t: 'tool', id, name: `mcp__ai-in-chrome__${name}`, input: truncate(args, 3000) });
      let result;
      let image;
      let ok = true;
      if (!OLLAMA_TOOLS.includes(name)) {
        ok = false;
        result = `Unknown tool "${name}". Available: ${OLLAMA_TOOLS.join(', ')}`;
      } else {
        const gate = await approved(s, name, args);
        if (!gate.ok) {
          ok = false;
          result = gate.message;
        } else {
          try {
            const res = await callTool(name, { ...args, __sid: s.sid });
            result = res.text || (res.image ? 'Screenshot taken.' : 'Done.');
            image = res.image;
          } catch (e) {
            ok = false;
            result = `Error: ${e.message}`;
          }
        }
      }
      emit({ t: 'tool_result', id, ok, text: truncate(result, 2000), image: image && image.data.length < 700000 ? `data:${image.mimeType};base64,${image.data}` : undefined });
      const toolMsg = { role: 'tool', tool_name: name, content: truncate(result, MAX_RESULT) };
      if (image) toolMsg.images = [image.data]; // used by vision models, ignored by others
      s.messages.push(toolMsg);
      if (signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
    }
    if (steps >= MAX_STEPS) {
      emit({ t: 'notice', text: `Stopped after ${MAX_STEPS} tool calls. Send another message to continue.` });
      break;
    }
  }
  return { ms: Date.now() - started, tokens, turns: steps + 1 };
}
