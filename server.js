/*
 * PiDP-1 Hacker Replicant — chat-backend
 *
 * AI tutor/copilot that sits next to Oscar Vermeulen's PiDP-1 replica: a web
 * page with the real front panel / CRT console on one side, and a chat panel
 * on the other that knows the PDP-1 (1959/1960, DEC's first computer),
 * Spacewar! (1962, the machine this game was written on), MACRO (the native
 * assembler) and LISP (one of the earliest interactive LISP
 * implementations) — and, if you let it, can mount a paper tape and press
 * READ IN for you.
 *
 * LLM-agnostic by design: the chat panel can talk to ANY backend that
 * speaks the OpenAI-compatible `/chat/completions` API with tool/function
 * calling. That covers Ollama (local, free, the default), and basically
 * every hosted provider (OpenAI, Groq, Together, Fireworks, DeepSeek,
 * Mistral, local llama.cpp/vLLM/LM Studio servers, etc.) for a faster
 * "cloud" option. Configure both via environment variables — see
 * .env.example and README.md. No vendor SDK, no hard dependency on any one
 * provider.
 *
 * Why this replica's tool set looks different from its siblings:
 * the PDP-1 has no terminal-line console at all. Input historically went
 * through the Soroban typewriter (FIODEC, character by character) and
 * output through the Type 30 CRT (a vector point-stream, not text) — there
 * is no `screen`-session-style "type a line, read a line" surface for an
 * agent to drive. What the replica *does* expose is a small set of discrete
 * BOOT actions (mount a paper tape image + flip the right console switches
 * + pulse READ IN/CONTINUE), served by pidp1-readin-server.py over a shared-
 * memory panel driver. So instead of send_keys/read_screen, this agent gets
 * three boot tools: boot_macro, boot_lisp, and pulse_readin. There is no
 * read-back tool — the agent cannot see the CRT or typewriter output, only
 * trigger boot procedures and report what it did. See skills/pdp1-tutor.md
 * for how the persona is expected to talk about this limitation.
 *
 * Two independent toggles, both controlled by the client on every request:
 *
 *   toolsEnabled (the control toggle, OFF by default on every page load)
 *     false -> plain knowledge chat. No tools, the agent can't touch the
 *              machine at all.
 *     true  -> the agent gets the three boot tools below, talking to the
 *              small boot-API running on the machine's host (see
 *              pidp1-readin-server.py). After ACTION_LIMIT tool calls in one
 *              turn, the loop stops and the agent has to ask in plain text
 *              whether it may continue — no silent, unbounded action streak.
 *
 *   backend ('local' | 'cloud', default 'local')
 *     Picks which entry in BACKENDS (below) to use. Both entries are just
 *     {baseUrl, apiKey, model} — same code path for either, no special-
 *     casing per provider.
 *
 * No server-side session storage: the client sends the full message
 * history with every request (same choice as the rest of the Hacker
 * Replicant family).
 */
import 'dotenv/config'; // loads .env for plain `node server.js` runs; a real
// EnvironmentFile= (systemd) or exported shell vars work fine too and simply
// take precedence over whatever .env sets, since dotenv never overwrites an
// already-set process.env value.
import express from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8102;
const BOOTAPI_BASE = process.env.BOOTAPI_BASE || 'http://localhost:8090';
const CONSOLE_URL = process.env.CONSOLE_URL || 'http://localhost:8080';
const DEFAULT_ACTION_LIMIT = Number(process.env.ACTION_LIMIT) || 5;
const HARD_CAP = 20; // defensive upper bound, independent of the user-facing limit — catches a broken loop
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 180000;

// Both backends speak the same OpenAI-compatible `/chat/completions` shape.
// 'local' defaults to a stock Ollama install (which has spoken this API
// since mid-2024); 'cloud' is unset by default — point it at whatever
// OpenAI-compatible provider you want for a faster/smarter option. Leaving
// CLOUD_BASE_URL empty just means the 'cloud' backend errors with a clear
// message instead of silently falling back — better than a confusing
// failure deep in a tool call.
const BACKENDS = {
  local: {
    baseUrl: stripTrailingSlash(process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1'),
    apiKey: process.env.LOCAL_API_KEY || '',
    model: process.env.LOCAL_MODEL || 'qwen3:14b',
  },
  cloud: {
    baseUrl: stripTrailingSlash(process.env.CLOUD_BASE_URL || ''),
    apiKey: process.env.CLOUD_API_KEY || '',
    model: process.env.CLOUD_MODEL || '',
  },
};

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

const SKILL = readFileSync(join(__dirname, 'skills', 'pdp1-tutor.md'), 'utf8');

// Standard OpenAI function-calling tool definitions — this exact shape is
// what every OpenAI-compatible provider (and Ollama) expects.
//
// Unlike the other Hacker Replicants there is no read-back tool here: the
// boot-API has no way to report what the CRT or typewriter are showing (it
// only pulses switches), so the agent can trigger a boot but cannot verify
// its result itself. Tell the user what you did and let them look.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'boot_macro',
      description:
        'Mount the MACRO assembler paper tape, reset all console switches ' +
        '(Test Word, Address, Sense Switches) to zero, and pulse READ IN to ' +
        'boot it. Use this when the user wants to assemble/run a MACRO ' +
        'program. Only call this after briefly telling the user in chat ' +
        'what you are about to do — this interrupts whatever is currently ' +
        'running on the machine.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'boot_lisp',
      description:
        'Mount the LISP paper tape and run the full historical boot ' +
        'procedure for it: EXTEND mode on, READ IN, then two Test-Word-plus-' +
        'CONTINUE steps (storage limit, then push-down list length), then ' +
        'Sense Switch 5 on plus CONTINUE to select typewriter input. Takes ' +
        'several seconds. Use this when the user wants to run LISP. Only ' +
        'call this after briefly telling the user in chat what you are ' +
        'about to do — this interrupts whatever is currently running on the ' +
        'machine.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pulse_readin',
      description:
        'Pulse the READ IN key once, without touching any switches or ' +
        'mounting a tape first. Useful for demos or restarting whatever is ' +
        'already mounted (e.g. after the user has set sense switches by ' +
        'hand on the physical panel for a demo like DDT). Only call this ' +
        'after briefly telling the user in chat what you are about to do.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// The boot-API is a flat GET/POST-either HTTP endpoint with no JSON body and
// no JSON response (plain "ok" or an error string) — simpler than the
// {baseUrl}/keys-and-/screen shape the screen-session-based replicas use,
// because there's no session to type into or read back from here.
async function execTool(name) {
  const routes = { boot_macro: '/boot/macro', boot_lisp: '/boot/lisp', pulse_readin: '/readin' };
  const path = routes[name];
  if (!path) return JSON.stringify({ error: `unknown tool: ${name}` });
  try {
    const r = await fetch(`${BOOTAPI_BASE}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    if (!r.ok) return JSON.stringify({ error: `boot-API HTTP ${r.status}: ${text.slice(0, 300)}` });
    return JSON.stringify({ ok: true, result: text.trim() });
  } catch (e) {
    return JSON.stringify({ error: 'boot-API unreachable: ' + e.message });
  }
}

// Single call function for BOTH backends — 'local' and 'cloud' are just
// different {baseUrl, apiKey, model}, same request/response shape. This is
// the whole point of standardizing on the OpenAI-compatible API: one code
// path, swap providers via environment variables, nothing to maintain per
// vendor.
async function callLLM(backendKey, messages, tools, modelOverride) {
  const cfg = BACKENDS[backendKey] || BACKENDS.local;
  if (!cfg.baseUrl) {
    throw new Error(
      `Backend '${backendKey}' is not configured — set ${backendKey.toUpperCase()}_BASE_URL ` +
        `(and optionally _API_KEY / _MODEL) in .env. See README.md.`
    );
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelOverride || cfg.model,
      messages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`${backendKey}-backend HTTP ${res.status} — ${bodyText.slice(0, 500)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    throw new Error(`${backendKey}-backend: unexpected response shape — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return msg; // { role: 'assistant', content, tool_calls?: [{id, type, function: {name, arguments: '<json-string>'}}] }
}

const app = express();
app.use(express.json());

// index.html has one placeholder (__CONSOLE_URL__) for the iframe/back-link
// pointing at the machine's own web console — substituted here so the page
// works out of the box once CONSOLE_URL is set, no client-side config call
// needed. Everything else in public/ is served as-is.
app.get('/', (req, res) => {
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8').replaceAll(
    '__CONSOLE_URL__',
    CONSOLE_URL
  );
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

app.post('/api/chat', async (req, res) => {
  const { messages, toolsEnabled, model, actionLimit, backend } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages (array) is required' });
  }
  const backendKey = backend === 'cloud' ? 'cloud' : 'local';
  const limit = Number.isInteger(actionLimit) && actionLimit > 0 ? actionLimit : DEFAULT_ACTION_LIMIT;

  // SSE instead of one blocking JSON response: a tool-using turn can take
  // anywhere from a few seconds (fast cloud model) to a couple of minutes
  // (a local model thinking out loud, or the multi-step LISP boot sequence
  // itself). Without intermediate events the UI would look broken for
  // anything but the fastest answers.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const systemNote = toolsEnabled
      ? `${SKILL}\n\n---\nThe control toggle is ON. You have boot_macro/boot_lisp/pulse_readin. ` +
        `Action limit this turn: ${limit} tool calls, after which you must ask in plain text ` +
        `whether you may continue — no more tool calls until the user confirms.`
      : `${SKILL}\n\n---\nThe control toggle is OFF. You have no tools — chat only.`;

    const convo = [{ role: 'system', content: systemNote }, ...messages];
    const tools = toolsEnabled ? TOOLS : undefined;
    const actionLog = [];
    let actionCount = 0;
    let hitLimit = false;

    for (let i = 0; i < HARD_CAP; i++) {
      send({ type: 'status', text: i === 0 ? 'thinking...' : 'processing the result...' });
      const useTools = hitLimit ? undefined : tools;
      const msg = await callLLM(backendKey, convo, useTools, model);
      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      if (!msg.tool_calls || !msg.tool_calls.length) {
        send({ type: 'done', response: msg.content || '(no answer)', actionLog, limitReached: hitLimit });
        return res.end();
      }

      // There are tool calls, but the limit was already hit this turn: ignore
      // them, force a plain-text question instead of acting further.
      if (hitLimit) {
        convo.push({
          role: 'system',
          content:
            'STOP. You have no tools left this turn, not even as text/pseudo-JSON. ' +
            'Write only a short, natural question now: summarize what you already did ' +
            'and ask whether you may continue with the rest. No function names, no JSON, ' +
            'no code block.',
        });
        continue;
      }

      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        send({ type: 'action', name, args: {} }); // visible immediately, not just at the end
        actionCount++;
        const result = await execTool(name);
        actionLog.push({ name, args: {}, result });
        convo.push({ role: 'tool', tool_call_id: call.id, content: result });
        if (actionCount >= limit) {
          hitLimit = true;
          break;
        }
      }
    }
    send({
      type: 'done',
      response: '(action/iteration limit reached without a final answer — try again)',
      actionLog,
      limitReached: true,
    });
    return res.end();
  } catch (e) {
    send({ type: 'error', message: `${req.body?.backend || 'local'}-backend error: ` + e.message });
    return res.end();
  }
});

app.listen(PORT, () => console.log(`PiDP-1 Hacker Replicant chat-backend on :${PORT}`));
