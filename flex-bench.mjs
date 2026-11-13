#!/usr/bin/env node
// flex-bench.mjs — What does the flex (async) tier actually cost you in time?
//
// Usage:
//   MODEL=zai-org/GLM-5.3-Flash node flex-bench.mjs
//   BASE_URL=https://api.doubleword.ai/v1 MODEL=... API_KEY=sk-... N=5 MAXTOK=1500 node flex-bench.mjs
//   (without API_KEY, falls back to Doubleword's apiKey in ~/.pi/agent/models.json;
//    custom endpoints require an explicit API_KEY — a stored Doubleword credential
//    is never sent to another host)
//
// Measures, per tier (realtime vs service_tier:"flex"), over N interleaved runs:
//   - TTFT (streaming: first token of any kind, reasoning included — i.e. what
//     a user waits through for reasoning models)
//   - total latency, visible tokens/sec (thinking tokens excluded from the rate)
//   - cost per request from the live catalog's per-tier tariffs + response usage
//
// Caveats: small sample, single model, reasoning models spend varying budgets
// thinking, and queueing behavior varies by hour. Run it yourself for numbers
// you can defend.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE_URL = (process.env.BASE_URL ?? "https://api.doubleword.ai/v1").replace(/\/+$/, "");
// Same credential policy as dev-role-probe.mjs: with a custom BASE_URL, require
// an explicit API_KEY — a stored Doubleword key is never sent to another host.
// $ENV_NAME references in models.json are resolved.
const DEFAULT_ENDPOINT = BASE_URL === "https://api.doubleword.ai/v1";
const API_KEY =
  process.env.API_KEY ??
  (DEFAULT_ENDPOINT
    ? (() => {
        try {
          const models = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/models.json", "utf8"));
          const raw = models?.providers?.doubleword?.apiKey;
          if (typeof raw === "string" && raw.startsWith("$")) return process.env[raw.slice(1)];
          if (typeof raw === "string" && raw.startsWith("!")) return undefined; // !command: pi-side dynamic key, not a literal
        } catch {
          return undefined;
        }
      })()
    : undefined);
if (!DEFAULT_ENDPOINT && !API_KEY) {
  console.error(
    "Refusing to run without an explicit API_KEY: BASE_URL is a custom endpoint, and this\n" +
      "script will not send a stored Doubleword credential to it. Set API_KEY=... explicitly.",
  );
  process.exit(1);
}
const MODEL = process.env.MODEL;
if (!MODEL) {
  console.error("Usage: MODEL=provider/model [API_KEY=...] [N=5] [MAXTOK=1500] node flex-bench.mjs");
  process.exit(1);
}
const N = Number(process.env.N ?? 5);
const MAXTOK = Number(process.env.MAXTOK ?? 2000); // reasoning models burn budget thinking; leave headroom

const CALLSIGN = randomBytes(4).toString("hex");
const PROMPT = `Benchmark ${CALLSIGN}. Write a fluent explanation, roughly 200 words, of why the sky is blue, for a curious ten-year-old. No headings, no lists.`;

// ---------------------------------------------------------------- pricing ----

const normKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function numberFrom(rec, keys) {
  for (const k of keys) {
    for (const [rk, rv] of Object.entries(rec)) {
      if (normKey(rk) === k) {
        const n = typeof rv === "number" ? rv : typeof rv === "string" ? Number(rv) : NaN;
        if (Number.isFinite(n)) return { value: n, key: k };
      }
    }
  }
  return undefined;
}

function tierOf(rec, label) {
  // Mirrors the pi extension: batch+1h ≈ async/flex tier, batch+24h ≈ offline batch.
  const hay = normKey(`${label ?? ""} ${rec.api_key_purpose ?? rec.purpose ?? ""}`);
  const window = normKey(rec.completion_window ?? rec.window ?? rec.sla ?? "");
  if (hay.includes("batch")) return window.includes("1h") && !window.includes("24h") ? "async" : "batch";
  if (hay.includes("async") || hay.includes("flex")) return "async";
  if (hay.includes("realtime")) return "realtime";
  return "realtime";
}

function tariffRates(rec) {
  const inp = numberFrom(rec, ["inputpricepertoken", "inputprice", "input", "inputpermtok", "inputpricepermtok"]);
  const out = numberFrom(rec, ["outputpricepertoken", "outputprice", "output", "outputpermtok", "outputpricepermtok"]);
  if (inp === undefined && out === undefined) return undefined;
  let input = inp?.value ?? out?.value ?? 0;
  let output = out?.value ?? inp?.value ?? 0;
  // Per-1M quoted values convert; per-token values pass through (same heuristic as the extension).
  const perMtok = [inp?.key ?? "", out?.key ?? ""].some((k) => k.includes("mtok"));
  const largest = Math.max(input, output);
  if (perMtok || (largest > 0 && largest >= 0.001)) {
    input = input / 1_000_000;
    output = output / 1_000_000;
  }
  return { input, output };
}

async function catalogRates(model) {
  const res = await fetch(`${BASE_URL}/models?include=pricing`, {
    headers: { ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
  });
  if (!res.ok) return { error: `catalog HTTP ${res.status}` };
  const j = await res.json();
  const entry = (j.data ?? j.models ?? []).find((m) => m.id === model);
  if (!entry) return { error: "model not in catalog" };
  const raw = Array.isArray(entry.tariffs)
    ? entry.tariffs.map((t) => [t?.name, t])
    : Object.entries(entry.tariffs ?? {});
  const tiers = { async: undefined, realtime: undefined };
  for (const [label, rec] of raw) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.is_active === false || rec.isActive === false) continue;
    const until = rec.valid_until ?? rec.validUntil;
    if (until && Number.isFinite(Date.parse(until)) && Date.parse(until) < Date.now()) continue;
    const rates = tariffRates(rec);
    if (!rates) continue;
    const key = tierOf(rec, label);
    if ((key === "async" || key === "realtime") && !tiers[key]) tiers[key] = rates;
  }
  return { tiers };
}

// ---------------------------------------------------------------- requests ----

async function chat(tier, { stream = true } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      stream,
      max_tokens: MAXTOK,
      ...(tier === "flex" ? { service_tier: "flex" } : {}),
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: PROMPT },
      ],
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    }),
  });
  const stats = {
    ttft: undefined, // first token of ANY kind (reasoning or visible)
    total: 0,
    chars: 0,          // visible chars
    thinkChars: 0,     // reasoning chars
    completionTokens: undefined,
    promptTokens: undefined,
    reasoningTokens: undefined,
    echoTier: undefined,
  };
  if (!res.ok) return { error: `HTTP ${res.status}`, ...stats };

  if (!stream) {
    const j = await res.json();
    stats.total = performance.now() - t0;
    stats.echoTier = j.service_tier ?? "(none)";
    stats.completionTokens = j.usage?.completion_tokens;
    stats.promptTokens = j.usage?.prompt_tokens;
    stats.reasoningTokens = j.usage?.completion_tokens_details?.reasoning_tokens;
    stats.chars = j.choices?.[0]?.message?.content?.length ?? 0;
    return { ok: true, ...stats };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done: rdDone, value } = await reader.read();
    if (rdDone) break;
    buf += decoder.decode(value, { stream: true });
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
      if (visible || thinking) {
        if (stats.ttft === undefined) stats.ttft = performance.now() - t0;
        stats.chars += visible.length;
        stats.thinkChars += thinking.length;
      }
      if (chunk.usage) {
        stats.completionTokens = chunk.usage.completion_tokens;
        stats.promptTokens = chunk.usage.prompt_tokens;
        stats.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
      }
    }
  }
  stats.total = performance.now() - t0;
  return { ok: true, ...stats };
}

// ------------------------------------------------------------------ report ----

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? NaN;
};
const fmt = (s, d = 2) => (s == null || Number.isNaN(s) ? "—" : s.toFixed(d));

async function main() {
  console.log(`Endpoint : ${BASE_URL}`);
  console.log(`Model    : ${MODEL}  (interleaved, ${N} runs/tier, max_tokens=${MAXTOK})\n`);

  const cat = await catalogRates(MODEL);
  if (cat.error) {
    console.log(`⚠️  ${cat.error} — costs will be marked UNPRICED`);
    cat.tiers = {};
  }
  const rts = (t) => cat.tiers?.[t];
  const rateStr = (t) => {
    const r = rts(t);
    return r ? `$${fmt(r.input * 1e6, 3)}/$${fmt(r.output * 1e6, 3)} per MTok` : "unpriced";
  };
  console.log(`Catalog rates — realtime: ${rateStr("realtime")} · flex: ${rateStr("async")}`);

  // Tier-echo proof (non-streaming carries the service_tier echo; streaming may not)
  const echoRt = (await chat("realtime", { stream: false })).echoTier;
  const echoFl = (await chat("flex", { stream: false })).echoTier;
  console.log(`Tier echo (non-stream) — realtime sent: (none) → got ${JSON.stringify(echoRt)} · flex sent: "flex" → got ${JSON.stringify(echoFl)}\n`);

  // interleaved to cancel time-of-day drift
  const samples = { realtime: [], flex: [] };
  for (let i = 0; i < N; i++) {
    const order = i % 2 === 0 ? ["realtime", "flex"] : ["flex", "realtime"];
    for (const t of order) samples[t].push(await chat(t));
  }

  const visibleTok = (s) =>
    s.reasoningTokens != null && s.completionTokens != null
      ? s.completionTokens - s.reasoningTokens
      : s.completionTokens ?? Math.round(s.chars / 3.5);
  const costOf = (s, t) => {
    const r = rts(t === "flex" ? "async" : t); // catalog keys tiers "async"; request tier is "flex"
    if (!r) return undefined;
    const pTok = s.promptTokens;
    const cTok = s.completionTokens;
    if (pTok === undefined && cTok === undefined) return undefined;
    return (pTok ?? 90) * r.input + (cTok ?? 0) * r.output; // reasoning billed as output
  };
  const est = (s) => s.reasoningTokens == null || s.completionTokens == null;

  for (const tier of ["realtime", "flex"]) {
    const runs = samples[tier];
    const ok = runs.filter((r) => r.ok);
    if (!ok.length) {
      console.log(`${tier.toUpperCase()}: all runs failed → ${runs[0]?.error ?? "?"}\n`);
      continue;
    }
    console.log(`${tier.toUpperCase()}`);
    ok.forEach((r, i) => {
      const vTok = visibleTok(r);
      const genSecs = (r.total - (r.ttft ?? r.total)) / 1000;
      const tps = genSecs < 0.1 ? NaN : vTok / genSecs; // burst delivery (flex) → no meaningful rate
      const tpsStr = Number.isNaN(tps) ? "burst" : `${fmt(tps, 1)} tok/s`;
      const cost = costOf(r, tier);
      console.log(
        `  run ${i + 1}: TTFT ${fmt(r.ttft / 1000)}s · total ${fmt(r.total / 1000)}s · ` +
          `${vTok ?? "—"} visible tok (${r.reasoningTokens ?? "?"} reasoning) · ${tpsStr} · ` +
          (cost == null ? "unpriced" : `$${cost.toFixed(4)}${est(r) ? "*" : ""}`),
      );
    });
    const mttft = median(ok.map((r) => r.ttft)) / 1000;
    const mtotal = median(ok.map((r) => r.total)) / 1000;
    const costs = ok.map((r) => costOf(r, tier)).filter((c) => c != null);
    const mcost = costs.length ? `$${median(costs).toFixed(4)}` : "unpriced";
    console.log(`  median: TTFT ${fmt(mttft)}s · total ${fmt(mtotal)}s · cost ${mcost}\n`);
  }

  const mr = (t, f) => {
    const ok = samples[t].filter((r) => r.ok);
    return ok.length ? median(ok.map(f)) : NaN;
  };
  const dCost =
    rts("realtime") && rts("async")
      ? `${fmt(((rts("async").output - rts("realtime").output) / rts("realtime").output) * 100, 1)}% cheaper (output rate)`
      : "—";
  const dTtft = `${fmt((mr("flex", (r) => r.ttft) - mr("realtime", (r) => r.ttft)) / 1000)}s slower`;
  const dTot = `${fmt((mr("flex", (r) => r.total) - mr("realtime", (r) => r.total)) / 1000)}s slower`;
  console.log(`Flex vs realtime →  price: ${dCost} · TTFT: ${dTtft} · total latency: ${dTot}`);
  console.log("* = tokens estimated from characters. Small sample; queueing varies by hour — run it yourself.");
}

await main();
