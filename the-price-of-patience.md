# The Price of Patience

*25% cheaper inference for coding agents, and the API compatibility bug I found along the way.*

[Doubleword](https://doubleword.ai) offers discounted inference for requests that tolerate flexible scheduling: instead of the standard tier, you opt into a queue — `service_tier: "flex"` — and the published tariff drops by roughly 25%, billed per token. I wanted to know whether that trade makes sense for a coding agent.

Unlike a chat application, a coding agent doesn't necessarily care when the first token arrives. What matters is how quickly it can complete a response and move on to its next step. So I connected [pi](https://github.com/badlogic/pi-mono), my coding agent, to Doubleword's flex tier, made the discount the default, and ran two audits.

The first measured cost and latency. In my initial tests, flex had published token rates 24–27% lower than realtime, and estimated request costs came out lower on every matched pair, while median end-to-end response time increased by under half a second.

The second audit uncovered something unexpected. My agent was completing requests successfully — but its instructions weren't reaching the model.

Both findings changed how I think about running coding agents on hosted inference.

## Connecting pi to Doubleword

Pi plugs into any OpenAI-compatible provider, but it doesn't know Doubleword's catalogue, and I wasn't going to hand-maintain a price list while the catalogue rotated underneath me. So I wrote an extension — one TypeScript file, ~600 lines, no dependencies — and the essential part of it fits in one stanza. Every catalogue entry becomes a pi model definition, and this is where both the discount and (spoiler) the bug live:

```ts
return {
  type: "chat",
  id,
  name,
  reasoning: true,                      // every model here takes reasoning_effort
  input: visionCapable(raw, id) ? ["text", "image"] : ["text"],
  compat: { supportsDeveloperRole: false },
  cost: costFor(raw, mode),             // per-request cost from the live tariff table
  samplingParams: mode === "async" ? { service_tier: "flex" } : undefined,
  contextWindow,
  maxTokens,
};
```

The extension fetches `GET /v1/models?include=pricing` at startup, sorts Doubleword's per-tier tariff records (the flex tier advertises itself, oddly but documentedly, as a batch tariff with a one-hour completion window), maps them into pi's cost fields, and stamps every request with the flex tier by default. Switching to the standard tier is one command, `/doubleword-mode realtime`; an environment variable makes it the global default. Two more pieces of plumbing matter: `refreshModels` hands pi a callback so *pi itself* can re-pull the catalogue (after `/login`, say) and get the same mapped models back — and if the catalogue is unreachable, the extension omits its model list entirely so hand-maintained fallbacks survive; and after any refresh it re-registers and rebinds the live session model, so price and tier changes land mid-conversation:

```ts
refreshModels: async (context) => { /* fetch + map, or undefined to keep the last catalogue */ },
// ...after a refresh:
const fresh = ctx.modelRegistry.find("doubleword", ctx.model.id);
if (fresh) await pi.setModel(fresh);
```

The full listing — credential handling, tariff parsing, the session-start recovery paths — is in the [companion guide](https://github.com/konarkmodi/pi-doubleword#readme). On paper, the arrangement was complete. On paper is where audits come from.

## Audit one: does flex actually save money, and how much slower is it?

Methodology first, because the numbers deserve their caveats attached. Same prompt to the same model (`zai-org/GLM-5.3-Flash`) through both tiers, rounds interleaved so the time of day couldn't take sides, five rounds per tier, streaming with token usage recorded. Request costs are *estimated*: observed token counts multiplied by Doubleword's published per-tier tariffs — which is a claim about the price list, not about Doubleword's billing system; verifying actual charges against invoices is a month-end exercise I haven't done. Three distinct things can be true at different strengths: the published discount, the estimated request cost, and the settled bill. I can vouch for the first two.

| Metric | Realtime | Flex (`service_tier:"flex"`) |
|---|---|---|
| Input price / 1M tok (published) | $0.150 | $0.110 |
| Output price / 1M tok (published) | $0.500 | $0.380 |
| Estimated request cost (median of 5)* | $0.0008 | $0.0005 |
| Time to first token (median) | **0.17 s** | 4.84 s |
| End-to-end latency (median) | 4.48 s | 4.84 s |
| Delivery | progressive stream (~55–95 tok/s) | single burst |
| Tier echo in response | — | `"flex"` confirmed |

*\*Estimated from observed usage × published tariffs, not verified against billing. Identical prompts drew wildly different reasoning budgets (211–1,992 tokens), so per-request medians are noisy; the stable signals are the published rate gap (−27% in / −24% out) and the fact that estimated cost came out lower on flex in every matched pair.*

Two results are worth pulling out. First, the advertised discount is real at the estimate level: every flex request priced 24–27% under its realtime twin. (Full disclosure of my priors: half-expecting the queue to be slow enough to eat the discount.) Second — and this is the commercially interesting part, which is why it gets a table instead of a clause — **all of the latency cost is paid before the first token, and almost none of it by the last one.** Median first token: 0.17 s vs 4.84 s. Median last token: 4.48 s vs 4.84 s, a difference of ~8%.

One structural detail matters for agent builders: flex responses arrive as a single burst — time-to-first-token *equals* time-to-last-token — because the queued response flushes complete. Pi waits for a complete response before acting on it anyway, so in pi's loop the operative metric *is* end-to-end completion, and flex costs it almost nothing. Systems that consume partial output incrementally — or an agent loop that starts acting on an unfinished tool call — would experience flex differently, and "time to first usable tool call" is the honest metric there. I didn't measure that variant; the scoped conclusion is:

> **For the tested coding-agent workflow, a substantial reduction in inference cost came with little observed increase in end-to-end completion time.**

Five rounds, one model, one testing period — small sample, deliberately acknowledged; the benchmark ships with the setup (`MODEL=… node flex-bench.mjs`) precisely so you can replace my numbers with yours.

## Audit two: the compatibility bug that silently broke my agent

The arrangement passed its functional audits first. Correct tier billing, eighteen models, tasks completed. Then, one day, I asked the agent a diagnostic question: what skills do you have? A coding agent carries its harness rules and its list of available skills in the system prompt, so a healthy agent answers this consistently.

First answer: eight skills, all correct. Minutes later, same question: "I don't have any skills."

Both delivered with total confidence. At most one can be true. The inconsistent answers suggested the agent wasn't receiving its instructions reliably — and the classic causes (a broken client, a mangled request) didn't fit, because the agent answered *questions* correctly all day; it was only ever its own instructions it couldn't describe.

The test that isolates this costs a penny and mostly cannot pass by luck: send the API a secret — a random, unguessable word — and ask for it back. If the model reproduces the secret, we know it can follow instructions delivered through that role. If it doesn't, instruction delivery or instruction handling has failed somewhere — the test alone cannot distinguish the two. Run it twice, expressing the same instruction in the two role values an "OpenAI-compatible" endpoint may see — the classic `system`, and the newer `developer` that OpenAI introduced in 2024, which modern libraries reach for whenever a model advertises reasoning support:

```jsonc
// raw HTTP, hand-built — no client library in between
{ "model": "zai-org/GLM-5.3-Flash", "messages": [
    { "role": "developer", "content": "The secret word is PINEAPPLE-42." },
    { "role": "user", "content": "What is the secret word? Reply with just the word." } ] }
```

Results, on Doubleword, for that model:

| Role used for the secret | Result |
|---|---|
| `system` | **PINEAPPLE-42** |
| `developer` | *"There is no secret word in my instructions."* |

Being precise about what this establishes — because it's the most important finding in the piece — and what it doesn't. It establishes, by construction, that the failure is not client-side serialization: the script above builds the request body itself, and the `developer`-role secret in that exact body was not reproduced while the `system`-role one was, against the same endpoint, seconds apart. Wire capture during the wider debugging confirmed the request was accepted with HTTP 200 and the `developer` message present in the payload as sent. What it does *not* establish is the mechanism on the server side: whether the message is dropped at the gateway, translated into something the model never attends to, or delivered with different priority. The behavioral outcome is the same in every case — instructions sent in that role do not reach the model — and for an operator, that's the part that matters.

Two more data points sharpen the picture. First, "OpenAI-compatible" describes request shape, not instruction semantics: on the *same* backend, one model family silently ignores `developer` messages while another (Qwen) rejects them outright with an HTTP 400 — the loud failure, which is the cheap one. Second, the `developer` role is OpenAI's own convention — introduced December 2024 for its reasoning models — so a third-party endpoint that never implemented it has broken no promise. None of that softens the operational risk: **an endpoint can be OpenAI-compatible at the HTTP level without being compatible with the instruction semantics your client expects.** A successful 200 can coexist with a missing system prompt.

The fix was one stanza — the `compat: { supportsDeveloperRole: false }` line visible in the extension snippet above — which tells pi to route the system prompt through `system` — the role supported by the tested endpoint, and by the long tail of the compatible ecosystem, though the probe exists precisely because "supported" is a per-endpoint fact, not a standard. Verified with the same probe: skills recited stably, instructions consistently described, across repeated asks.

## What I learned

Two findings earn their place in permanent notes.

First, the economics. Agent workflows are priced by tokens but experienced by completion time, and those have different sensitivities: flex moved first-token latency by seconds and end-to-end latency by hundreds of milliseconds. When a consumer only needs the finished response, a front-loaded queue is nearly free latency — and a quarter off the bill. The same discount evaluated against a streaming chat product would be a bad trade.

Second, the compatibility one, because it outlives Doubleword's price list. Successful requests, accurate price metadata, and delivered instructions are three separate properties of a stack — each can hold without the others. The failure mode here produced no error, no latency, no cost anomaly; it produced an agent that quietly worked from general-purpose priors instead of its instructions, indistinguishable from healthy until someone asked it to describe itself twice. The general test is thirty seconds and a penny: a secret word in every instruction role you use, asked back, against every provider you trust.

Successful requests, accurate price metadata, and delivered instructions are three separate properties of an inference stack. This experiment found that the first two can work while the third fails silently.

**A 200 response is not a delivered instruction.**

---

*The extension, the setup guide with all commands and environment variables, and both tools (`dev-role-probe.mjs`, `flex-bench.mjs`) are in the [companion guide](https://github.com/konarkmodi/pi-doubleword#readme). All measurements in this piece come from November 2026 against `zai-org/GLM-5.3-Flash`; rerun them before quoting any number here.*
