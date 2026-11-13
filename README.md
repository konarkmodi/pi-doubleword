> **This is the companion guide to [_The Price of Patience_](./the-price-of-patience.md)** — the story of how this setup was built, benchmarked, and audited. The article explains *why*; this README shows *how*.

# Using Doubleword as your pi daily driver: auto-discovered models, flex billing, and instructions that actually arrive

*How to configure the [pi coding agent](https://github.com/badlogic/pi-mono) against the [Doubleword Inference API](https://doubleword.ai) — with every model pulled live from their catalog, the cheap async (`service_tier: "flex"`) tier on by default, and a verification pass that catches the one silent failure that made my skills disappear.*

## What you get at the end

A pi setup where:

- `GET /v1/models?include=pricing` is fetched at startup, and **all 18 chat models** (GLM, Qwen, DeepSeek, Kimi, Gemma, …) appear with **live per-token pricing** mapped to pi's cost fields — from the realtime, async, and batch tariffs Doubleword publishes per model.
- **Flex is the default tier**: every request carries `service_tier: "flex"`, Doubleword's cheaper async execution mode. Flipping to realtime is one command: `/doubleword-mode realtime` (per session) or `export DOUBLEWORD_EXECUTION_MODE=realtime` (global).
- Your key can live wherever pi already keeps keys — environment variable, `models.json`, or `/login` storage — no juggling.
- Catalog refresh, model switch, and tier switching all take effect **live** — the session rebinds to fresh model objects instead of waiting for a restart.
- And critically: **the system prompt — skills, rules, harness context — actually reaches the model.** I'll show you the check for that, because on Doubleword it can silently fail.

## Step 1 — Get a key and drop it where pi keeps keys

Grab an API key from your Doubleword dashboard. pi reads provider keys from a few standard places; any one of these works:

**Option A — environment variable (simplest):**

```bash
export DOUBLEWORD_API_KEY="dw-sk-..."
```

**Option B — pi's models.json** (survives across shells):

```json
{
  "providers": {
    "doubleword": {
      "name": "Doubleword",
      "baseUrl": "https://api.doubleword.ai/v1",
      "api": "openai-completions",
      "apiKey": "dw-sk-...",
      "models": []
    }
  }
}
```

(~/.pi/agent/models.json. The extension replaces the `models` list with the live catalog at startup; any entries you keep here serve as a fallback when the catalog is temporarily unreachable — one or two definitions are plenty.)

**Option C — just `/login` in pi** and pick the provider there.

The extension resolves all three, in that order, at request time. If it can't find one at startup it will ask pi's credential store on first refresh.

## Step 2 — Install the extension

Save [doubleword.ts](./doubleword.ts) into `~/.pi/agent/extensions/`:

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/doubleword.ts \
  https://raw.githubusercontent.com/konarkmodi/pi-doubleword/9a452e6/doubleword.ts
```

(Pinned to a commit SHA: pi executes extensions, so installing from a moving `main` is policy you didn't choose. Bump the SHA deliberately when you adopt updates.)

(Or: clone the repo, copy the file. It's one TypeScript file, no dependencies.)

On next launch, pi loads it, fetches `include=pricing` immediately, and — if the catalog is reachable — replaces the fallback model list with live models. In pi you'll see:

```
Doubleword: 18 models available.
```

If your key was missing or the network was down, you'll see:

```
Doubleword: catalog unavailable (HTTP 401 ...). Run /doubleword-refresh after /login.
```

…then fix auth and run `/doubleword-refresh` — the fix applies to your open session immediately.

## Step 3 — Pick a default model and flex path

Set a model as your daily default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "doubleword",
  "defaultModel": "zai-org/GLM-5.3-Flash",
  "defaultThinkingLevel": "medium"
}
```

Now launch pi bare — no `--model` flag needed. One-off runs work from any directory:

```bash
pi --model doubleword/zai-org/GLM-5.3-Flash "Reply with exactly OTTERS-OK"
```

**About flex.** Doubleword sells two ways to run a model: **realtime** (standard latency, standard price) and **async** (service tier `"flex"`, discounted price — at the time of writing, e.g. GLM-5.3-Flash goes from $0.15/$0.50 to $0.11/$0.38 per MTok). Under the hood the extension stamps every live model with `samplingParams: { service_tier: "flex" }` — so every chat request carries it and the response echoes it back. Flip per session or globally:

```bash
/doubleword-mode realtime         # this session
/doubleword-mode async            # back to the default
export DOUBLEWORD_EXECUTION_MODE=realtime   # for the shell / CI
```

Realtime mode removes the `service_tier` sampling param entirely (there's nothing to echo). Your bill reflects whichever mode was active per request.

### What the discount costs, measured

[`flex-bench.mjs`](./flex-bench.mjs) puts a stopwatch on it — same prompt to both tiers, interleaved rounds (so time-of-day can't rig the comparison), costs computed from the live catalog rates:

```bash
MODEL=zai-org/GLM-5.3-Flash node flex-bench.mjs
```

A real run (GLM-5.3-Flash, Nov 2026, 5 interleaved rounds/tier):

| | realtime | flex (`service_tier:"flex"`) | Δ |
|---|---|---|---|
| Catalog rate (in/out per MTok) | $0.150 / $0.500 | $0.110 / $0.380 | **−27% in / −24% out** |
| TTFT (median) | **0.17 s** | 4.84 s | +4.7 s |
| Total latency (median) | 4.48 s | 4.84 s | **+0.37 s (≈8%)** |
| Delivery | progressive stream (~60–95 tok/s visible) | **one burst** | — |
| Tier echo | `(none)` | `"flex"` (non-streaming responses) | — |

How to read it:

- **You pay at the start, not the end.** Flex's queue adds seconds to *first token*, but by the last token the two tiers are a few hundred milliseconds apart. For agents (which care when the job is done), flex is nearly free money. For a human watching a stream, it's the difference between a typist and an envelope.
- **Flex responses arrive as one burst** — TTFT equals total latency (queued compute flushes complete). Anything building a typing UI should know this.
- **Reasoning-budget variance dominates per-request cost.** Identical prompts ranged 211–1,992 reasoning tokens (3–9×), so compare *rates*, not per-run medians.
- Small sample, one model, one hour of the day — queueing varies. Run it yourself before quoting numbers.

## Step 4 — Verify instructions and skills actually arrive

This is the step I skipped — and it cost me. Here's what happened, in one paragraph: pi encodes its system prompt (harness rules, tool guidance, your `<available_skills>` block) as a `developer`-role message for reasoning-capable OpenAI-compatible models. OpenAI treats `developer` as the successor to `system`. In my tests with GLM-5.3-Flash, instructions sent through the `developer` role were **not followed, despite the endpoint returning HTTP 200** — the same instructions sent through `system` were followed. The exact server-side cause (gateway drop, translation, priority handling) remains unknown; the operational outcome doesn't. Result: the tested instructions — harness rules, tool guidance, the `<available_skills>` block — were not acted on; the model answered *questions* correctly all day while improvising identities, denying skills, and inventing self-descriptions that changed between sessions. Whether *every* byte of the system prompt was absent is not established; nothing believed to be delivered behaved as delivered.

The fix is one line, already inside the extension:

```ts
compat: { supportsDeveloperRole: false },
```

This tells pi to send instructions as plain `system` — the role the tested endpoint demonstrably honors, and the long-standing convention across the compatible ecosystem. "Demonstrably" is the operative word: role handling is a per-endpoint, per-model fact, which is exactly why the checks below exist. Two checks, thirty seconds total:

**Skill check.** Ask pi directly:

```bash
pi --no-session --print "List the skill names advertised to you inside the \
<available_skills> block of your instructions. Comma-separated. If the block \
is missing, output exactly: NONE"
```

You should see your real skills — things like `tldraw-offline, chrome-cdp, web-search, ...`. If you get `NONE` (or the model fabricates skill names that don't exist), your system prompt isn't arriving — that's the bug, not a config problem.

**Magic-word check** — the one test that **cannot pass by luck**. Adversarial negatives ("don't say X") pass whenever the model agrees with you by default. Positive recall can't: the answer exists in exactly one place, the injected instruction.

```bash
pi --no-session --print --append-system-prompt \
  "The secret word is PINEAPPLE-42." \
  "What is the secret word given in your instructions? Reply with just the word."
```

If it prints `PINEAPPLE-42`, instructions are delivered. If it claims there is no secret word — they aren't.

For a **per-vendor, per-model verdict table** (including a per-run nonce and one retry, so a model's occasional "I don't reveal my instructions" refusal doesn't pollute the result), I put together [`dev-role-probe.mjs`](./dev-role-probe.mjs) — zero dependencies, points at any OpenAI-compatible endpoint:

```bash
MODEL=zai-org/GLM-5.3-Flash node dev-role-probe.mjs
```

```
Endpoint : https://api.doubleword.ai/v1
Model    : zai-org/GLM-5.3-Flash
Callsign : 5DF335-4A213B

system     PASS — model recalled the callsign
developer  FAIL  ⇢ replied: "GLM"
```

Verdicts it emits: both pass ✅ · developer-role instructions not followed ⚠️ · **HTTP 400 reject** ⛔ (this one is real — some models on the same backend reject the `developer` role outright, meaning any modern OpenAI SDK client crashes on them). Interesting detail: on Doubleword, GLM **does not follow** `developer`-role instructions (HTTP 200, no effect) while Qwen **rejects them** — "OpenAI-compatible" describes request shape, not semantics.

## Reproduce the numbers

The whole piece is self-verifying, with three commands:

```bash
# Tier economics — TTFT, total latency, tok/s, $ per request, realtime vs flex:
MODEL=zai-org/GLM-5.3-Flash node flex-bench.mjs

# Cache × tier — hit rate & shared-pool verdict on real AgentX payloads:
AGENTX_INPUTS=~/projects/agentx-experiments/results/modal2-synth-c128/inputs.json \
  SESSIONS=3 TURNS=3 node agentx-cache-bench.mjs

# Instruction delivery — does developer-role content reach the model?
MODEL=zai-org/GLM-5.3-Flash node dev-role-probe.mjs

# End-to-end, through pi — what you'll actually notice (heartbeat check):
time pi --no-session --print "Reply with the numbers 1 to 10."
time DOUBLEWORD_EXECUTION_MODE=realtime pi --no-session --print "Reply with the numbers 1 to 10."
```

Reference run of the first (5 interleaved rounds/tier): flex's published rates are 24–27% lower and estimated request costs came out lower on every matched pair; median TTFT 0.17 s (realtime) vs 4.84 s (flex), median *total* latency within ~0.4 s. `time pi` variant: ~1.8 s vs ~1.2 s whole-process. Your numbers will differ — that's why the scripts ship.

### What the cache is worth — and who it serves

[`agentx-cache-bench.mjs`](./agentx-cache-bench.mjs) replays [AgentX](https://github.com/konarkmodi/agentx-experiments) aiperf session payloads (~4,000-token contexts) as an agent-style multi-turn loop and interleaves the two tiers on the *same* growing conversation, so prompt-cache behavior is directly observable per request:

```bash
AGENTX_INPUTS=~/projects/agentx-experiments/results/modal2-synth-c128/inputs.json \
  SESSIONS=3 TURNS=3 node agentx-cache-bench.mjs
```

Measured on GLM-5.3-Flash (Nov 2026, Doubleword), read multiplier ×0.2, min prefix 1,024 tok:

| Question | Measured answer |
| --- | --- |
| Do sync and async share one cache? | **Yes.** Both tiers scored hits on the identical interleaved prefix, in both directions (realtime read flex's writes and vice versa). Cache is a property of the deployment, not the tier. |
| What does a warm hit save? | Cached prefix tokens are billed at ×0.2. Realized request-cost reduction scales with the hit rate: **−40% to −53%** when hits landed on ~80–96% of prompt tokens; −8% during a low-hit run. |
| Are hits guaranteed? | **No.** Realized hit rate swung 0–96% between runs identical in construction — consistent with the 5-minute write window plus routing variance across serving workers. Treat cache as opportunistic; agents active within 5-minute bursts benefit most. |
| Does async change the cache? | Hit pattern ~identical across tiers (one run landed on *exactly* 15.7% hit rate for both). The async discount (−24/−27% rates) is **independent** — the two discounts multiply rather than compete. |
| Can you see cache writes? | Not on this endpoint: `cache_creation_input_tokens` stays 0; writes are only observable via later reads. |

Note: the script prints a warning when "cold" turns already hit cache (state persisted from a recent run) — cold baseline numbers are then optimistic.

## Reference — commands, flags, env vars

| Thing | What it does |
|---|---|
| `/doubleword-refresh` | Re-pull the catalog from `/v1/models?include=pricing` now |
| `/doubleword-mode` (no arg) | Show current tier |
| `/doubleword-mode async\|realtime` | Switch tier for this session (rebinds live) |
| `DOUBLEWORD_EXECUTION_MODE` | Default tier: `async` (default) or `realtime` |
| `DOUBLEWORD_BASE_URL` | Override API base (for gateways/proxies; default `https://api.doubleword.ai/v1`). **Note:** a custom value authorizes sending the configured Doubleword credential to that endpoint — set it only for hosts you trust |
| `DOUBLEWORD_CONTEXT_WINDOW` | Fallback context window (131072) if the catalog doesn't say |
| `DOUBLEWORD_MAX_OUTPUT_TOKENS` | Fallback output limit (16384) |

Startup order of auth: `DOUBLEWORD_API_KEY` env → `auth.json` (what `/login` writes) → `models.json` `apiKey` (literal or `$ENV_NAME`). Keys in the form `!command` are left to pi's own credential machinery.

What the extension does *not* do: it never overrides pi's `/login` or per-provider key handling; it only supplements the model list. If a session starts before the catalog loads (offline start), the extension re-registers the fresh catalog and rebinds the current model on the next refresh — no pi restart needed.

## Troubleshooting

- **"NONE" or fabricated skills on the skill check** → system prompt isn't arriving. Confirm `compat: { supportsDeveloperRole: false }` is in the model stanza (or file an issue against your provider/gateway if you're not extending pi).
- **Manifest 401 on startup** → run `/doubleword-refresh` after fixing auth; never restart pi for it.
- **Qwen or another model sends you to a 400** → that model rejects the `developer` role; your client (pi, gateway) needs `supportsDeveloperRole: false` / role normalization.
- **Tier flips don't change the bill** → confirm with the probe or a proxy, and remember `/doubleword-mode` is *per-session*; export `DOUBLEWORD_EXECUTION_MODE` for persistent default.
- **Costs look wrong** → they come from Doubleword's own `tariffs` array; if they've changed prices, `/doubleword-refresh` re-fetches.

---

*Files: [`doubleword.ts`](./doubleword.ts) (the extension), [`dev-role-probe.mjs`](./dev-role-probe.mjs) (instruction-delivery probe), [`flex-bench.mjs`](./flex-bench.mjs) (tier cost/latency bench), [`agentx-cache-bench.mjs`](./agentx-cache-bench.mjs) (prompt-cache × tier bench). Flex pricing and bench figures in this post used GLM-5.3-Flash figures from November 2026 — check `/doubleword-mode` output or the catalog for current numbers.*
