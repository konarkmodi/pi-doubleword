#!/usr/bin/env node
// agentx-cache-bench.mjs — Does the flex (async) tier see the same prompt cache?
//
// Replays real AgentX aiperf session payloads (results/<run>/inputs.json) as an
// agent-style multi-turn loop: the same long user context + a growing tail of
// short assistant/user turns. Every turn re-sends the identical growing prefix,
// so `cached_tokens` on turn k>1 is a direct cache-hit measurement — and because
// realtime and flex calls are INTERLEAVED on the same conversation, hits on the
// tier that didn't just write the cache prove the two tiers share one cache pool.
//
// Usage:
//   node agentx-cache-bench.mjs
//   AGENTX_INPUTS=~/projects/agentx-experiments/results/modal2-synth-c128/inputs.json SESSIONS=2 TURNS=3 node agentx-cache-bench.mjs
//   (defaults: MODEL=zai-org/GLM-5.3-Flash, BASE_URL=https://api.doubleword.ai/v1;
//    without API_KEY, falls back to Doubleword's apiKey in ~/.pi/agent/models.json;
//    custom endpoints require an explicit API_KEY — a stored Doubleword credential
//    is never sent to another host; !command-style entries are rejected as literals)
//
// Reports per tier (realtime vs service_tier:"flex"):
//   - cold turn: cache tokens written, TTFT, total latency
//   - warm turns: cache hit rate (cached_tokens / prompt tokens), TTFT, total
//   - est. cost per request with published cache multipliers vs the same request uncached
//   - cross-tier verdict: shared pool / tier-separate / no hits observed
//
// Zero dependencies.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const MODEL = process.env.MODEL ?? "zai-org/GLM-5.3-Flash";
const SESSIONS = Number(process.env.SESSIONS ?? 2);
const TURNS = Number(process.env.TURNS ?? 3);
// GLM-5.3-Flash reasoning can burn >200 tokens before any visible output;
// too small a cap yields finish_reason:"length" with EMPTY visible content.
const OUT_TOK = Number(process.env.OUT_TOK ?? 800);
const DEFAULT_ENDPOINT = "https://api.doubleword.ai/v1";
const BASE_URL = (process.env.BASE_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, "");

// Credential policy (same as flex-bench.mjs): a stored credential is read only
// for the default Doubleword endpoint; custom endpoints require an explicit key.
const API_KEY =
  process.env.API_KEY ??
  (BASE_URL === DEFAULT_ENDPOINT
    ? (() => {
        try {
          const models = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/models.json", "utf8"));
          const raw = models?.providers?.doubleword?.apiKey;
          if (typeof raw === "string" && raw.startsWith("$")) return process.env[raw.slice(1)];
          if (typeof raw === "string" && raw.startsWith("!")) return undefined; // !command: pi-side dynamic key, not a literal
          return raw;
        } catch {
          return undefined;
        }
      })()
    : (() => {
        console.error(
          "A custom BASE_URL requires an explicit API_KEY — refusing to reuse a stored Doubleword credential on another host.",
        );
        process.exit(1);
      })());

if (!API_KEY) {
  console.error("No API key found (DOUBLEWORD_API_KEY / models.json apiKey).");
  process.exit(1);
}

const AGENTX_INPUTS =
  process.env.AGENTX_INPUTS ?? `${process.env.HOME}/projects/agentx-experiments/results/modal2-synth-c128/inputs.json`;

// ------------------------------------------------------------ AgentX input ----

function loadSessions() {
  const j = JSON.parse(readFileSync(AGENTX_INPUTS, "utf8"));
  const data = (Array.isArray(j) ? j : j.data).map((s) => s.payloads ?? s.messages ?? s);
  // aiperf synth inputs: one payload (the long user context) per session
  const sessions = data
    .map((payloads) => payloads[0]?.messages?.[0]?.content)
    .filter((c) => typeof c === "string" && c.length > 4000);
  if (!sessions.length) {
    console.error(`No usable session contexts in ${AGENTX_INPUTS}`);
    process.exit(1);
  }
  return sessions;
}

const contexts = loadSessions().slice(0, SESSIONS);
const RUN = randomBytes(3).toString("hex");

// Agent-loop conversation: turn 1 = long context + kickoff question; turn k =
// same context + short canned assistant/user tail. Assistant content is canned
// because only prefix stability matters for cache observability.
const ASSISTANT_FILLER = "Right — noted. Ready for the next question.";
function buildConversation(contextText, turn) {
  const kickoff = "Question 1 (answer in exactly one sentence): name the text's subject in five words or fewer.";
  const msgs = [{ role: "user", content: `${contextText}\n\n${kickoff}` }];
  for (let k = 1; k < turn; k++) {
    msgs.push({ role: "assistant", content: ASSISTANT_FILLER });
    msgs.push({ role: "user", content: `Question ${k + 1}: in exactly one sentence, what changes if the subject above were repeated ten more times?` });
  }
  return msgs;
}

// ------------------------------------------------------------------ plumbing --

const fmtUsd = (x) => (x == null ? "—" : Number.isFinite(x) ? "$" + x.toFixed(5) : "—");
const fmt = (x) => (x == null ? "—" : Number.isFinite(x) ? Number(x.toFixed(x >= 100 ? 0 : 2)) : "—");
const normKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const median = (a) => (a.length ? a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

function numberFrom(rec, keys) {
  for (const k of keys) {
    for (const [rk, rv] of Object.entries(rec)) {
      if (normKey(rk) === k) {
        const n = typeof rv === "number" ? rv : typeof rv === "string" ? Number(rv) : NaN;
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

// Mirrors flex-bench.mjs: batch + 1h completion window ≈ async/flex tier.
function tierOf(rec, label) {
  const hay = normKey(`${label ?? ""} ${rec.api_key_purpose ?? rec.purpose ?? ""}`);
  const window = normKey(rec.completion_window ?? rec.window ?? rec.sla ?? "");
  if (hay.includes("batch")) return window.includes("1h") && !window.includes("24h") ? "flex" : "batch";
  if (hay.includes("async") || hay.includes("flex")) return "flex";
  if (hay.includes("realtime")) return "realtime";
  return "realtime";
}

async function catalogRates() {
  const res = await fetch(`${BASE_URL}/models?include=pricing`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`Catalog fetch failed (HTTP ${res.status}); cost rows will be omitted.`);
    return { tiers: {}, cachePricing: {} };
  }
  const j = await res.json();
  const entry = (j.data ?? j.models ?? []).find((m) => m.id === MODEL);
  if (!entry) return { tiers: {}, cachePricing: {} };
  const tiers = {};
  for (const t of entry.pricing?.tariffs ?? entry.tariffs ?? []) {
    const tier = tierOf(t, "");
    if (tier === "batch") continue;
    tiers[tier] = {
      input: numberFrom(t, ["inputpricepertoken", "inputpricepermtok", "inputprice", "input"]) ?? NaN,
      output: numberFrom(t, ["outputpricepertoken", "outputpricepermtok", "outputprice", "output"]) ?? NaN,
    };
  }
  const cpRec = entry.cache_pricing ?? entry.cachePricing ?? {};
  const num = (v) => (v == null ? undefined : typeof v === "number" ? v : Number(v)) || undefined;
  const cachePricing = {
    readMult: num(cpRec.read_multiplier) ?? 1,
    writeMult5m: num(cpRec.write_multiplier_5m) ?? 1,
    minPrefix: num(cpRec.min_prefix_tokens) ?? 0,
  };
  return { tiers, cachePricing };
}

// Catalog rates arrive per-token (e.g. 0.00000011); the magnitude guard keeps
// this correct even if a provider later publishes per-MTok numbers instead.
const rts = (r) =>
  r && Number.isFinite(r.input) && Number.isFinite(r.output) && r.input >= 0
    ? {
        input: r.input >= 0.001 ? r.input / 1e6 : r.input,
        output: r.output >= 0.001 ? r.output / 1e6 : r.output,
      }
    : undefined;

let seq = 0;
async function chat(tier, messages) {
  const id = ++seq;
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: OUT_TOK,
      ...(tier === "flex" ? { service_tier: "flex" } : {}),
      stream_options: { include_usage: true },
      messages,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    console.error(`  [${tier}] HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const stats = {
    ttft: undefined, total: undefined, promptTokens: undefined, completionTokens: undefined,
    cachedTokens: 0, writeTokens: 0,
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // tolerate split SSE frames
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      const visible = delta.content ?? "";
      const thinking = delta.reasoning_content ?? "";
      if ((visible || thinking) && stats.ttft === undefined) stats.ttft = performance.now() - t0;
      const u = chunk.usage;
      if (u) {
        stats.promptTokens = u.prompt_tokens ?? stats.promptTokens;
        stats.completionTokens = u.completion_tokens ?? stats.completionTokens;
        stats.cachedTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? stats.cachedTokens ?? 0;
        stats.writeTokens = u.cache_creation_input_tokens ?? stats.writeTokens ?? 0;
      }
    }
  }
  stats.total = performance.now() - t0;
  return stats;
}

const cacheAwareCost = (s, tier, cat) => {
  const r = rts(cat.tiers[tier]);
  if (!r || s.promptTokens == null) return undefined;
  const created = s.writeTokens ?? 0;
  const cached = s.cachedTokens ?? 0;
  const plain = Math.max(0, s.promptTokens - cached - created);
  return cached * r.input * cat.cachePricing.readMult + created * r.input * cat.cachePricing.writeMult5m + plain * r.input + (s.completionTokens ?? 0) * r.output;
};
const uncachedCost = (s, tier, cat) => {
  const r = rts(cat.tiers[tier]);
  if (!r || s.promptTokens == null) return undefined;
  return s.promptTokens * r.input + (s.completionTokens ?? 0) * r.output;
};

// --------------------------------------------------------------------- main --

const cat = await catalogRates();
const cp = cat.cachePricing;
console.log(
  `agentx-cache-bench — run ${RUN}\n` +
    `  model ${MODEL} · ${contexts.length} session(s) × ${TURNS} turns · tiers interleaved per turn\n` +
    `  published cache: read ×${cp.readMult} · write ×${cp.writeMult5m} · min prefix ${cp.minPrefix || "?"} tok\n` +
    `  context: ${AGENTX_INPUTS.split("/").slice(-2).join("/")}\n`,
);

const R = { realtime: [], flex: [] };
for (const [si, contextText] of contexts.entries()) {
  for (let turn = 1; turn <= TURNS; turn++) {
    const messages = buildConversation(contextText, turn);
    // Alternate the tier ordering per turn so neither tier systematically
    // goes first; each tier's turn k directly follows the other tier's turn
    // on the identical prefix — cross-tier hits are unambiguous.
    const order = turn % 2 === 1 ? ["realtime", "flex"] : ["flex", "realtime"];
    for (const tier of order) {
      const s = await chat(tier, messages);
      if (!s) continue;
      R[tier].push({ session: si + 1, turn, ...s });
      console.log(
        `  s${si + 1} t${turn} ${tier.padEnd(8)} cache rd ${String(s.cachedTokens ?? "—").padStart(4)} · wr ${String(s.writeTokens ?? "—").padStart(4)} · prompt ${String(s.promptTokens ?? "—").padStart(4)} · TTFT ${fmt((s.ttft ?? NaN) / 1000)}s · total ${fmt(s.total / 1000)}s`,
      );
    }
  }
}

// ------------------------------------------------------------------ summary --

console.log("\nSUMMARY");
const cold = (recs) => recs.filter((r) => r.turn === 1);
const warm = (recs) => recs.filter((r) => r.turn > 1);
const perTier = {};
for (const tier of ["realtime", "flex"]) {
  const c = cold(R[tier]);
  const w = warm(R[tier]);
  const cachedTok = w.reduce((a, r) => a + (r.cachedTokens ?? 0), 0);
  const promptTok = w.reduce((a, r) => a + (r.promptTokens ?? 0), 0);
  const warmHit = promptTok ? (cachedTok / promptTok) * 100 : 0;
  const warmCost = w.reduce((a, r) => a + (cacheAwareCost(r, tier, cat) ?? 0), 0);
  const warmUn = w.reduce((a, r) => a + (uncachedCost(r, tier, cat) ?? 0), 0);
  const coldCost = c.reduce((a, r) => a + (cacheAwareCost(r, tier, cat) ?? 0), 0);
  perTier[tier] = { c, w, warmHit, warmCost, warmUn, coldCost };
  const coldReads = c.filter((r) => (r.cachedTokens ?? 0) > 0).length;
  console.log(
    `${tier.padEnd(9)} cold: ${c.length} req, TTFT med ${fmt(median(c.map((r) => r.ttft)) / 1000)}s, est ${fmtUsd(coldCost)}` +
      (coldReads ? ` (${coldReads} cold req already hit cache — state persisted from a previous run; cold numbers are optimistic)` : "") +
      `\n${" ".repeat(9)} warm: ${w.length} req, hit ${warmHit.toFixed(1)}% of prompt tok, TTFT med ${fmt(median(w.map((r) => r.ttft)) / 1000)}s, total med ${fmt(median(w.map((r) => r.total)) / 1000)}s` +
      `\n${" ".repeat(9)} est warm cost ${fmtUsd(warmCost)} vs same uncached ${fmtUsd(warmUn)} (−${warmUn ? fmt(((warmUn - warmCost) / warmUn) * 100) : "?"}%)`,
  );
}
const fw = perTier.flex.w.filter((r) => (r.cachedTokens ?? 0) > 0).length;
const rw = perTier.realtime.w.filter((r) => (r.cachedTokens ?? 0) > 0).length;
console.log(
  fw > 0 && rw > 0
    ? "\n→ cache pool appears SHARED across tiers: both tiers scored hits on the identical interleaved prefix."
    : fw === 0 && rw === 0
      ? "\n→ no cache hits observed for either tier (prefix under minimum, caching endpoint-gated, or writes still pending)."
      : `\n→ cache pool appears TIER-SEPARATE: hits only on ${fw ? "flex" : "realtime"}.`,
);
