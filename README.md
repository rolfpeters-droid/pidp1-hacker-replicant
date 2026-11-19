# PiDP-1 Hacker Replicant

An AI tutor/copilot that sits next to Oscar Vermeulen's PiDP-1 replica: a
web page with the real front panel / CRT console on one side, and a chat
panel on the other that knows **Spacewar!** (1962, the first real computer
game, written on this exact machine), **MACRO** (the native assembler), and
**LISP** (one of the earliest interactive LISP implementations) — and, if
you let it, can mount a paper tape and press READ IN for you.

This is the **original inspiration** for the whole Hacker Replicant family.
Oscar Vermeulen's own `agent-pdp1` — a Hermes-based AI tutor for the PiDP-1
— predates all of it, including the PiDP-11 version that this repo's
structure is otherwise modeled on. This package is an independent,
from-scratch reimplementation of that idea: no Hermes, a much smaller
harness, LLM-agnostic instead of tied to one provider, and — the part that
makes this machine different from every other replica in the family — a
tool set built around *boot actions* instead of a typed console, because
the PDP-1 genuinely has no terminal line to type into or read back from.
See "Why this one is different" below.

![PiDP-1 Hacker Replicant — console on one side, chat panel on the other](docs/screenshot.png)

*No screenshot is bundled with this repo (this package doesn't ship its own
web console — see "Bring your own console" below). The layout matches the
rest of the Hacker Replicant family: a console panel and a chat panel,
side by side.*

## Why this one is different

Every other machine in this family (PDP-8, PDP-10, PDP-11, VAX, HP 3000)
has an actual terminal: a `screen` session the agent can type into
(`screen -X stuff`) and read back from (`screen -X hardcopy`), because
those machines are driven by a text console one way or another.

The PDP-1 has no such thing. Historically, input went through the Soroban
typewriter (FIODEC, one character at a time) and output went to a Type 30
CRT — a vector point-stream display, not a character grid. There is no
line-oriented console to attach a `screen` session to, and no sensible way
to "read back" a point-stream picture as text. What the replica *does*
expose is a small, well-defined set of **boot procedures**: mount a paper
tape image, set the right console switches, and pulse READ IN (and, for
LISP, a short sequence of Test-Word-plus-CONTINUE steps afterward). That's
a real, physical-panel-accurate action — not a shortcut — and it's the only
thing that can be driven programmatically without faking the hardware.

So instead of `send_keys`/`read_screen`, the agent here gets three tools:

- `boot_macro` — mount the MACRO assembler tape, zero all switches, READ IN.
- `boot_lisp` — mount the LISP tape and run the full historical boot
  sequence for it (EXTEND on, READ IN, two TW+CONTINUE steps, Sense Switch
  5 on, CONTINUE).
- `pulse_readin` — a bare READ IN pulse, for demos or restarting whatever
  is already mounted.

There is **no read-back tool**. The agent can trigger a boot, but it cannot
see the CRT or the typewriter, so it cannot verify what happened on its
own — it has to tell you what it did and let you look at the screen
yourself. `skills/pdp1-tutor.md` is explicit with the model about this
limitation; it's not something to work around, it's an honest description
of what this hardware allows.

## How it works

```
Browser
 │
 ├─ One panel: <iframe> → your own PiDP-1 web console (CONSOLE_URL)
 │      Not included in this repo -- bring your own. See below.
 │
 └─ Other panel: chat → POST /api/chat (SSE stream)
      │  this Node service (server.js)
      │
      ├─ LLM backend: any OpenAI-compatible /chat/completions API
      │  (local Ollama by default, or a hosted provider -- see below)
      │
      └─ when the control toggle is ON, three tools only:
           boot_macro    → POST <BOOTAPI_BASE>/boot/macro
           boot_lisp     → POST <BOOTAPI_BASE>/boot/lisp
           pulse_readin  → POST <BOOTAPI_BASE>/readin
           (served by pidp1-readin-server.py, included in this repo)
```

`pidp1-readin-server.py` talks to the replica's hardware panel driver
(`panel_pidp1`) through a shared-memory segment (`/tmp/pdp1_panel`,
`mmap`), pulsing switch bits the same way a human hand would flip them —
and briefly pausing the driver (`SIGSTOP`/`SIGCONT`) for the duration of a
multi-step boot sequence like LISP's, so the driver doesn't race it and
erase a setting within a couple hundred milliseconds. It also sends a
couple of plain-text commands (`r <tape>`, `muldiv on`) to the emulator's
TCP command port to mount tape images. None of this touches a `screen`
session, because there isn't one to touch.

## Bring your own console

Unlike the PiDP-11 package, this repo does **not** bundle a web console.
Point `CONSOLE_URL` at whatever already drives your PiDP-1 replica's WebGL
CRT display — most PiDP-1 builds already have something along these lines
running (Oscar's own software, or your own). This package only adds the
chat panel and the boot-API bridge; it assumes the console itself already
exists and works.

## LLM-agnostic by design

The chat backend talks to **any backend that speaks the OpenAI-compatible
`/chat/completions` API with tool/function calling** — that's one code
path for both:

- **Local** (default, free): point it at a local [Ollama](https://ollama.com)
  install. Ollama has spoken this API since mid-2024, nothing extra to
  configure beyond pulling a model that supports tool calling (`qwen3`,
  `llama3.1`+, `mistral-nemo`, etc. all do).
- **Cloud** (optional, for a faster/smarter option): point it at OpenAI,
  Groq, Together, Fireworks, DeepSeek, Mistral, OpenRouter, a hosted
  vLLM/TGI endpoint — anything OpenAI-compatible. See `.env.example` for
  examples.

No vendor SDK, no hard dependency on any single provider, no API key
required at all if you only use the local backend.

**A heads-up on local "thinking" models:** Ollama's OpenAI-compatible
endpoint (what the local backend uses) doesn't currently expose a way to
turn off a reasoning model's internal "thinking" step the way Ollama's own
native API does (`think: false`). For `qwen3` specifically this means every
reply carries a few hundred tokens of hidden reasoning, adding roughly
10-20 extra seconds per turn. `LLM_TIMEOUT_MS` already accounts for this
(default 180s), so nothing breaks, it just feels slower than it has to. If
snappier replies matter more to you than using a reasoning model locally,
point `LOCAL_MODEL` at a non-thinking model instead (`llama3.1`,
`mistral-nemo`, etc. all support tool calling without this overhead).

## Setup

### Prerequisites

- A PiDP-1 replica with its hardware panel driver (`panel_pidp1`) and
  emulator running, and an existing web console pointed at it (see "Bring
  your own console" above).
- `/tmp/pdp1_panel` reachable and `panel_pidp1` controllable via
  SIGSTOP/SIGCONT from the account that runs `pidp1-readin-server.py` —
  this only works on the Pi that's actually driving the replica.
- Node.js 18+ and Python 3 on that same host (for the boot-API).
- [Ollama](https://ollama.com) running somewhere reachable (for the free
  local backend), or an API key for a cloud provider.

The chat backend (`server.js`) can run anywhere and just point
`BOOTAPI_BASE`/`CONSOLE_URL` at the Pi over the network. `pidp1-readin-server.py`
must run on the Pi itself — it shells out to the emulator's command port and
mmaps a local file.

### Install

```bash
git clone <this-repo-url>
cd pidp1-hacker-replicant
npm install
cp .env.example .env
# edit .env: at minimum set CONSOLE_URL and BOOTAPI_BASE to match your setup
```

### Run the boot-API (on the Pi, bridges the chat agent to the panel)

```bash
python3 pidp1-readin-server.py
```

Adjust `TAPE_DIR` at the top of the file if your tape images don't live
under `/opt/pidp1/tapes`.

### Run the chat backend

```bash
npm start
```

Open `http://<host>:8102/` (or whatever `PORT` you set) — `CONSOLE_URL`
should point at your existing web console.

### Running both as services

See `docs/pidp1-hacker-replicant.service.example` and
`docs/pidp1-readin-server.service.example` for ready-to-adapt systemd units.

## Configuration reference

All configuration is environment variables — see `.env.example` for the
full list with examples. The short version:

| Variable | What |
|---|---|
| `PORT` | Port the chat backend listens on |
| `CONSOLE_URL` | Your existing web console, shown in the left panel |
| `BOOTAPI_BASE` | Where `pidp1-readin-server.py` is reachable |
| `ACTION_LIMIT` | Tool calls per turn before the agent must ask to continue |
| `LOCAL_BASE_URL` / `LOCAL_API_KEY` / `LOCAL_MODEL` | Local (default) backend |
| `CLOUD_BASE_URL` / `CLOUD_API_KEY` / `CLOUD_MODEL` | Optional cloud backend |
| `LLM_TIMEOUT_MS` | Timeout for a single LLM call |

## Safety model

- The control toggle is **off** on every page load — by default the agent
  only talks, it never touches the machine.
- When on, the agent gets exactly three tools (`boot_macro`, `boot_lisp`,
  `pulse_readin`), nothing else — no shell, no filesystem, no network
  access beyond the boot-API, and no way to read anything back.
- After `ACTION_LIMIT` tool calls in one turn, the agent is cut off from
  further tool calls and must ask in plain text whether it may continue —
  no silent, unbounded action streak. A hard iteration cap (20) sits
  underneath as a defensive backstop against a broken loop.
- Every boot action is a real, physical-panel-accurate switch sequence —
  nothing happens that couldn't also happen by someone reaching over and
  flipping the same switches themselves.
- This does **not** protect you from the agent booting the wrong thing at
  the wrong time (it's an LLM, it can make mistakes) — the boundary is on
  *what* it can touch, not on *how well* it decides to touch it. Use a
  local/free backend if you want to experiment without any cost risk.

## Repository layout

```
server.js                     Chat backend (Node/Express, SSE, LLM-agnostic)
public/                        Chat panel UI
pidp1-readin-server.py         Shared-memory panel bridge for the chat agent's tools
skills/pdp1-tutor.md           System prompt: PDP-1 knowledge + behavior rules (Dutch)
docs/                          Example systemd units (not installed automatically)
```

## Adapting this for a different replica

If your machine *does* have a typed console (most do), the PiDP-11 package
in this same family is the better starting template — its
`send_keys`/`read_screen` pair over a `screen` session is simpler and more
general than what's here. This package is specifically for machines whose
replica only exposes discrete boot/panel actions, not a line console.

`skills/pdp1-tutor.md` is the only file that's actually PDP-1-specific
content; swap it for a system prompt about your own machine and point
`server.js` at the new file.

## Credits

Built by Rolf Peters with Seb (his homelab AI assistant), in collaboration
with Oscar Vermeulen (designer of the PiDP replica series). As noted above,
this whole family of "Hacker Replicant" tutors traces back to Oscar's own
`agent-pdp1` project for the PiDP-1 — this package is a fresh, independent
implementation of that idea for this specific machine, not a fork of it.

## License

MIT — see `LICENSE`.
