/**
 * doubleword.ts — Doubleword provider extension for Pi
 *
 * Automatically pulls ALL available models from the Doubleword Inference API
 * (https://docs.doubleword.ai) and registers them as the `doubleword` provider.
 *
 * How it works:
 *   1. On startup it fetches `GET /v1/models?include=pricing` (OpenAI-compatible)
 *      and registers every chat-capable model it finds.
 *   2. A `refreshModels` hook keeps the catalog live, so Pi can re-pull the list
 *      whenever models refresh (e.g. `/doubleword-refresh`).
 *   3. Realtime vs async (flex) tier: async is the default — every request
 *      carries `service_tier: "flex"` and model costs use the async tariff.
 *      Switch per session with `/doubleword-mode realtime` (or set
 *      DOUBLEWORD_EXECUTION_MODE=realtime to change the default).
 *
 * Configuration (all optional, via environment variables):
 *   DOUBLEWORD_API_KEY           Inference API key (get one at app.doubleword.ai/api-keys).
 *                                If unset, the provider shows as unconfigured and you
 *                                can store a key with `/login`.
 *   DOUBLEWORD_BASE_URL          API base URL. Default: https://api.doubleword.ai/v1
 *                                (self-hosted Control Layer: your own /v1 endpoint).
 *                                SECURITY NOTE: setting this to a custom endpoint
 *                                AUTHORIZES sending the configured Doubleword
 *                                credential (env var or stored key) to that host —
 *                                the extension does not double-guess the override.
 *                                A keyless pi-side credential (`!command`) is still
 *                                left to pi's own machinery.
 *   DOUBLEWORD_EXECUTION_MODE    "async" (default) or "realtime"
 *   DOUBLEWORD_CONTEXT_WINDOW    Fallback context window (default 131072) when the
 *                                API does not advertise one
 *   DOUBLEWORD_MAX_OUTPUT_TOKENS Fallback output limit (default 16384)
 *
 * Per-model overrides (reasoning flag, context window, …) can be layered on top
 * in ~/.pi/agent/models.json under the `doubleword` provider — models.json is
 * composed above extension-registered models.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.doubleword.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

type Mode = "realtime" | "async";

function numEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

const FALLBACK_CONTEXT_WINDOW = numEnv("DOUBLEWORD_CONTEXT_WINDOW") ?? DEFAULT_CONTEXT_WINDOW;
const FALLBACK_MAX_OUTPUT_TOKENS = numEnv("DOUBLEWORD_MAX_OUTPUT_TOKENS") ?? DEFAULT_MAX_OUTPUT_TOKENS;

function normMode(value: string | undefined): Mode | undefined {
	const v = value?.trim().toLowerCase();
	if (v === "async" || v === "flex") return "async";
	if (v === "realtime" || v === "real-time" || v === "live" || v === "standard") return "realtime";
	return undefined;
}

/**
 * The key may live in Pi's own storage instead of the environment:
 * `~/.pi/agent/auth.json` (per-provider /login) or `~/.pi/agent/models.json`
 * under the `doubleword` provider (literal or `$ENV`). `!command` keys are
 * skipped at startup; they still resolve later via the refresh credential.
 */
function resolveStoredCredentialKey(): string | undefined {
	const dir = join(homedir(), ".pi", "agent");
	try {
		const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
		const entry = auth?.doubleword;
		const key = entry?.type === "api_key" ? entry?.key : undefined;
		if (typeof key === "string" && key) return key;
	} catch {}
	try {
		const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		const raw = models?.providers?.doubleword?.apiKey;
		if (typeof raw === "string" && raw) {
			if (raw.startsWith("$")) return process.env[raw.slice(1)];
			if (raw.startsWith("!")) return undefined; // dynamic key: resolved via refresh credential later
			return raw;
		}
	} catch {}
	return undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Normalize a key so `context_window`, `contextWindow`, `context-window` match. */
function normKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Flattened lookup: check the object itself, then common metadata buckets. */
function lookup(obj: unknown, normalizedKeys: string[]): unknown {
	const scopes: Record<string, unknown>[] = [];
	if (obj && typeof obj === "object") {
		const rec = obj as Record<string, unknown>;
		scopes.push(rec);
		for (const bucket of ["metadata", "meta", "extra", "info"]) {
			if (rec[bucket] && typeof rec[bucket] === "object") scopes.push(rec[bucket] as Record<string, unknown>);
		}
	}
	for (const scope of scopes) {
		const map = new Map<string, unknown>();
		for (const [k, v] of Object.entries(scope)) map.set(normKey(k), v);
		for (const key of normalizedKeys) {
			const v = map.get(key);
			if (v !== undefined && v !== null) return v;
		}
	}
	return undefined;
}

function numberAt(obj: unknown, keys: string[]): number | undefined {
	const v = lookup(obj, keys);
	if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return undefined;
}

function stringAt(obj: unknown, keys: string[]): string | undefined {
	const v = lookup(obj, keys);
	return typeof v === "string" ? v : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Pricing: parse the `tariffs` field of /v1/models?include=pricing
//
//   Observed shape (per model entry):
//     tariffs: [{ name, api_key_purpose, completion_window?,
//                 input_price_per_token, output_price_per_token,
//                 valid_from, valid_until, is_active }, ...]
//     cache_pricing: { enabled, read_multiplier, write_multiplier_5m|_1h|_24h,
//                      min_prefix_tokens }
//
//   `api_key_purpose` picks the tier: "realtime", "batch" (+ completion_window:
//   1h ≈ the async/flex tier per the pricing page, 24h ≈ offline batch), or
//   "playground". Prices arrive as per-token strings. Cache read/write prices
//   are the input price scaled by the cache_pricing multipliers. The exact
//   shape is undocumented, so parsing stays defensive and supports the object
//   form ({ realtime: { input, output } }) as a fallback.
// ---------------------------------------------------------------------------

interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const UNKNOWN_COST: Rates = { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN };

type RateField = keyof Rates;

const RATE_ALIASES: Record<RateField, string[]> = {
	input: [
		"inputpricepertoken", "inputprice", "input", "inputpermtok", "inputpricepermtok",
		"prompt", "promptprice", "promptpricepertoken",
	],
	output: [
		"outputpricepertoken", "outputprice", "output", "outputpermtok",
		"completion", "completionprice", "completionpricepertoken",
	],
	cacheRead: ["cacheread", "cachereadprice", "cachereadpricepertoken", "cachedinput", "cachedinputprice", "cachehit"],
	cacheWrite: ["cachewrite", "cachewriteprice", "cachewritepricepertoken", "cachewritepermtok"],
};

function extractRates(tier: unknown): Rates | undefined {
	if (!tier || typeof tier !== "object") return undefined;
	// Search the tier object; a tier like { price: {...} } also works.
	const scopes: Record<string, unknown>[] = [tier as Record<string, unknown>];
	for (const bucket of ["price", "rates", "pricing", "tariff"]) {
		const nested = (tier as Record<string, unknown>)[bucket];
		if (nested && typeof nested === "object") scopes.push(nested as Record<string, unknown>);
	}
	const rates: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let found = false;
	for (const [field, aliases] of Object.entries(RATE_ALIASES) as [RateField, string[]][]) {
		for (const scope of scopes) {
			const map = new Map<string, unknown>();
			for (const [k, v] of Object.entries(scope)) map.set(normKey(k), v);
			for (const alias of aliases) {
				const v = map.get(alias);
				if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
					rates[field] = v;
					found = true;
					break;
				}
				if (typeof v === "string") {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0) {
						rates[field] = n;
						found = true;
						break;
					}
				}
			}
		}
	}
	return found ? rates : undefined;
}

/** Classify a tariff record into realtime / async / batch / playground. */
function classifyTier(item: Record<string, unknown>, fallbackLabel?: string): "realtime" | "async" | "batch" | "playground" {
	// api_key_purpose is authoritative when present; completion_window
	// disambiguates batch pricing (1h window ≈ the async/flex tier).
	const purpose = normKey(stringAt(item, ["apikeypurpose", "purpose"]) ?? "");
	const window = normKey(stringAt(item, ["completionwindow", "window", "sla"]) ?? "");
	if (purpose) {
		if (purpose.includes("batch")) return window.includes("1h") && !window.includes("24h") ? "async" : "batch";
		if (purpose.includes("async") || purpose.includes("flex")) return "async";
		if (purpose.includes("realtime")) return "realtime";
		if (purpose.includes("playground") || purpose.includes("play")) return "playground";
	}
	const n = normKey(`${fallbackLabel ?? ""} ${purpose}`);
	if (n.includes("playground") || n.includes("play")) return "playground";
	if (n.includes("realtime")) return "realtime";
	if (n.includes("batch")) return n.includes("24h") ? "batch" : "async";
	if (n.includes("async") || n.includes("flex")) return "async";
	return "realtime";
}

interface TierEntry {
	key: "realtime" | "async" | "batch" | "playground";
	rates: Rates;
}

/** Accept tariffs as an array of tier records or an object keyed by tier. */
function collectTiers(tariffs: unknown): TierEntry[] {
	const entries: TierEntry[] = [];
	if (Array.isArray(tariffs)) {
		for (const item of tariffs) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			// Skip inactive or past-validity tariffs.
			if (lookup(rec, ["isactive", "active"]) === false) continue;
			const until = stringAt(rec, ["validuntil"]);
			if (until) {
				const t = Date.parse(until);
				if (Number.isFinite(t) && t < Date.now()) continue;
			}
			const rates = extractRates(rec);
			if (rates) entries.push({ key: classifyTier(rec), rates });
		}
	} else if (tariffs && typeof tariffs === "object") {
		for (const [name, value] of Object.entries(tariffs as Record<string, unknown>)) {
			const rates = extractRates(value);
			if (rates) entries.push({ key: classifyTier(value as Record<string, unknown>, name), rates });
		}
	}
	return entries;
}

/** Blend cache_pricing multipliers into the tier's rates. */
function withCachePricing(rates: Rates, cachePricing: unknown): Rates {
	const cp = cachePricing && typeof cachePricing === "object" ? (cachePricing as Record<string, unknown>) : undefined;
	const enabled = cp ? cp["enabled"] === true || cp["enabled"] === "true" : false;
	if (!enabled) return { ...rates, cacheRead: rates.input, cacheWrite: rates.input };
	const readMult = numberAt(cp, ["readmultiplier", "read", "cachereadmultiplier"]);
	const writeMult = numberAt(cp, ["writemultiplier5m", "write5m", "writemultipliershort"]);
	return {
		input: rates.input,
		output: rates.output,
		cacheRead: readMult !== undefined ? rates.input * readMult : rates.input,
		cacheWrite: writeMult !== undefined ? rates.input * writeMult : rates.input,
	};
}

/** Tariffs are per-token already (verified shape); per-1M quoted values convert too.
 *  Unit detection is heuristic (magnitude): a per-token string smaller than 0.001
 *  is treated as per-token, everything else as per-1M. The live Doubleword shape
 *  is "0.00000038"-style per-token strings, so this is safe today — but it IS a
 *  heuristic, which is why UNKNOWN_COST ever shows up at all. */
function toTokenRates(rates: Rates): Rates {
	const largest = Math.max(
		rates.input,
		rates.output,
		rates.cacheRead,
		rates.cacheWrite,
	);
	if (largest > 0 && largest < 0.001) return rates; // already per-token
	if (largest === 0) return UNKNOWN_COST; // no usable prices parsed
	return {
		input: rates.input / 1_000_000,
		output: rates.output / 1_000_000,
		cacheRead: rates.cacheRead / 1_000_000,
		cacheWrite: rates.cacheWrite / 1_000_000,
	};
}

function costFor(raw: unknown, mode: Mode): Rates {
	const tariffs = lookup(raw, ["tariffs", "tariff", "pricing", "prices"]);
	const tiers = collectTiers(tariffs);
	// Pricing is unknown when no tier parses — visible as NaN in pi's UI, never
	// as a misleading $0. A zero can only mean the API genuinely quoted zero.
	if (!tiers.length) return UNKNOWN_COST;
	// The server may not publish every tier for every model; fall back in the
	// order a mismatched request would realistically be billed.
	const order: TierEntry["key"][] =
		mode === "async"
			? ["async", "realtime", "playground", "batch"]
			: ["realtime", "playground", "async", "batch"];
	const tier = order.map((key) => tiers.find((t) => t.key === key)).find(Boolean) ?? tiers[0];
	return toTokenRates(withCachePricing(tier.rates, lookup(raw, ["cachepricing", "cachepricing"])));
}

// ---------------------------------------------------------------------------
// Catalog mapping: raw /v1/models entries -> Pi model configs
// ---------------------------------------------------------------------------

const NON_CHAT_HINTS = ["embedding", "embed", "rerank", "reranker", "classifier", "classification", "tts", "speech", "whisper", "transcri"];
const VISION_HINTS = ["vision", "image", "multimodal", "visual", "ocr", "vgpu"];

function visionCapable(raw: unknown, id: string): boolean {
	const caps = lookup(raw, ["capabilities", "features", "modalities", "tags", "abilities"]);
	const capList = Array.isArray(caps) ? caps.join(" ") : typeof caps === "string" ? caps : "";
	// Note: normKey strips separators, so ID hints are matched against a
	// separator-preserving lowercase id instead.
	if (VISION_HINTS.some((h) => normKey(capList).includes(h))) return true;
	const idHay = id.toLowerCase();
	// Qwen VL family ("-vl-"), Qwen-VL style, OCR-capable deployments.
	return /(^|[^a-z0-9])vl([^a-z0-9]|$)/.test(idHay) || idHay.includes("vlm") || idHay.includes("ocr");
}

/** Every chat model currently served on Doubleword takes reasoning_effort
 *  (Chat Completions) per https://docs.doubleword.ai/inference-api/reasoning-controls.
 *  `thinkingLevelMap.off` is left unset: thinking "off" sends no field, which
 *  sidesteps Qwen3 deployments that reject reasoning_effort: "none". */
function reasoningCapable(_raw: unknown, _id: string): boolean {
	return true;
}

function isNonChat(raw: unknown, id: string): boolean {
	const type = stringAt(raw, ["type", "modeltype", "modality", "category", "endpoint", "endpointtype"]) ?? "";
	const haystack = normKey(`${type} ${id}`);
	return NON_CHAT_HINTS.some((h) => haystack.includes(h));
}

function toChatModel(raw: unknown, mode: Mode): ProviderModelConfig | undefined {
	const id = stringAt(raw, ["id", "model", "modelname", "modelfullname"]);
	if (!id) return undefined;
	if (isNonChat(raw, id)) return undefined;

	const contextWindow = numberAt(raw, ["contextwindow", "maxcontexttokens", "contextlength", "maxmodellen", "maxcontextlength", "maxcontext"]) ?? FALLBACK_CONTEXT_WINDOW;

	// Plausible explicit output limit, else max_tokens when unambiguous, else fallback.
	const maxTokens =
		numberAt(raw, ["maxoutputtokens", "maxcompletiontokens", "maxnewtokens", "maxoutput"]) ??
		(() => {
			const mt = numberAt(raw, ["maxtokens"]);
			if (mt && mt < contextWindow && mt >= 1024) return mt;
			return undefined;
		})() ??
		FALLBACK_MAX_OUTPUT_TOKENS;

	const name = stringAt(raw, ["displayname", "shownname", "label"]) ?? stringAt(raw, ["name"]) ?? id;

	return {
		type: "chat",
		id,
		name,
		reasoning: reasoningCapable(raw, id),
		input: visionCapable(raw, id) ? ["text", "image"] : ["text"],
		// Doubleword drops `developer`-role messages verbatim (verified: model
		// answers system-role instructions but claims none exist with developer
		// role) — force pi's system prompt (harness rules + <available_skills>)
		// to be sent as `system`.
		compat: { supportsDeveloperRole: false },
		cost: costFor(raw, mode),
		// Async (flex) tier: Doubleword runs service_tier="flex" on a normal request.
		samplingParams: mode === "async" ? { service_tier: "flex" } : undefined,
		contextWindow,
		maxTokens,
	};
}

function mapCatalog(payload: unknown, mode: Mode): ProviderModelConfig[] {
	const data = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
	const raws = Array.isArray(data) ? data : [];
	const models: ProviderModelConfig[] = [];
	for (const raw of raws) {
		const model = toChatModel(raw, mode);
		if (model) models.push(model);
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

async function fetchCatalog(baseUrl: string, apiKey: string | undefined, signal: AbortSignal | undefined): Promise<unknown> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models?include=pricing`;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const detail = response.status === 401 ? "invalid or missing API key" : `HTTP ${response.status}`;
		throw new Error(`GET ${url} failed: ${detail}`);
	}
	return response.json();
}

async function fetchCatalogModels(
	baseUrl: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	mode: Mode,
): Promise<ProviderModelConfig[]> {
	return mapCatalog(await fetchCatalog(baseUrl, apiKey, signal), mode);
}

function credentialKey(credential: unknown): string | undefined {
	if (credential && typeof credential === "object") {
		const rec = credential as { type?: unknown; key?: unknown };
		if (rec.type === "api_key" && typeof rec.key === "string" && rec.key) return rec.key;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface DoublewordProviderConfig {
	name: string;
	baseUrl: string;
	apiKey?: string | undefined;
	authHeader: boolean;
	api: string;
	models?: ProviderModelConfig[] | undefined;
	refreshModels(context: {
		signal?: AbortSignal | undefined;
		allowNetwork: boolean;
		credential?: unknown;
	}): Promise<ProviderModelConfig[] | undefined>;
}

export default async function doublewordExtension(pi: ExtensionAPI) {
	const baseUrl = process.env.DOUBLEWORD_BASE_URL?.trim() || DEFAULT_BASE_URL;
	// Credential policy: overriding the endpoint via DOUBLEWORD_BASE_URL is a
	// deliberate operator decision — overriding AUTHORIZES sending the configured
	// Doubleword credential (env var or stored key) to that host. The extension
	// therefore doesn't silently re-point stored credentials: with a custom
	// endpoint, only DOUBLEWORD_API_KEY supplies a key here (pi-side credential
	// stores are left to pi's own resolution at request time).
	const customEndpoint = baseUrl !== DEFAULT_BASE_URL;
	let mode: Mode = normMode(process.env.DOUBLEWORD_EXECUTION_MODE) ?? "async";
	let lastError: string | undefined;

	// Startup fetch (before registration): makes the catalog available to
	// session start and `pi --list-models`, offline-tolerant via try/catch.
	// The key can come from the environment or from Pi's own storage
	// (auth.json / models.json) — otherwise the request would 401 and the
	// session would bind PI to stale models.json fallback models without
	// the tier sampling params.
	let currentModels: ProviderModelConfig[] = [];
	let startupError: string | undefined;
	const storedKey = resolveStoredCredentialKey();
	try {
		currentModels = await fetchCatalogModels(
			baseUrl,
			process.env.DOUBLEWORD_API_KEY || (customEndpoint ? undefined : storedKey),
			AbortSignal.timeout(20_000),
			mode,
		);
	} catch (error) {
		startupError = errorMessage(error);
	}
	const startupHadCatalog = currentModels.length > 0;

	// Rebuilding the full config makes refresh-driven catalog changes visible
	// to the composer: re-register (last registration wins), then rebind the
	// session model so an already-selected stale object picks up the new one.
	const register = () => {
		// Auth claim (so pi.setModel rebinds work and the session stays wired):
		// prefer the environment variable by reference; otherwise reuse the
		// literal key resolved from storage. `!command`-style keys are never
		// claimed — pi resolves those as credentials on its own.
		//
		// Catalog: when no models have been fetched yet (offline, or no
		// credential), omit `models` entirely so hand-maintained models.json
		// entries survive as fallback until a credentialed refresh succeeds.
		const apiKeyClaim = process.env.DOUBLEWORD_API_KEY
			? { apiKey: "$DOUBLEWORD_API_KEY" }
			: storedKey && !customEndpoint
				? // Stored credentials are only claimed for the default endpoint; a
					// custom DOUBLEWORD_BASE_URL means the operator wires credentials
					// themselves (env var or pi's own credential machinery).
					{ apiKey: storedKey }
				: {};
		const config: DoublewordProviderConfig = {
			name: "Doubleword",
			baseUrl,
			...apiKeyClaim,
			authHeader: true,
			api: "openai-completions",
			models: currentModels.length > 0 ? currentModels : undefined,
			refreshModels: async (context) => {
				if (!context.allowNetwork) return undefined; // keep the current catalog
				lastError = undefined;
				try {
					const apiKey = credentialKey(context.credential) ?? process.env.DOUBLEWORD_API_KEY ?? storedKey;
					if (!apiKey) return undefined; // unconfigured; /login stores the key
					const models = await fetchCatalogModels(baseUrl, apiKey, context.signal, mode);
					currentModels = models; // visible to register() callers after refresh
					return models;
				} catch (error) {
					if (!context.signal?.aborted) lastError = errorMessage(error);
					return undefined; // keep the previously known catalog
				}
			},
		};
		pi.registerProvider("doubleword", config as never);
	};

	register();

	// After a refresh the composer still holds the previously registered model
	// list, and the session keeps streaming with its already-bound Model object.
	// Re-register with the fresh catalog and swap the session onto the refreshed
	// instance so sampling params (service_tier) and pricing take effect live.
	// ctx also carries modelRegistry (and other helpers); the structural type
	// here only names what this function uses.
	const applyRefreshedCatalog = async (ctx: {
		model?: { provider: string; id: string } | undefined;
		modelRegistry: {
			find: (provider: string, id: string) => unknown;
		};
	}) => {
		register();
		const current = ctx.model;
		if (!current || current.provider !== "doubleword" || !pi.setModel) return;
		const fresh = ctx.modelRegistry.find("doubleword", current.id);
		if (fresh) await pi.setModel(fresh as never);
	};

	pi.registerCommand("doubleword-refresh", {
		description: "Re-pull the Doubleword model catalog from /v1/models",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ providers: ["doubleword"], allowNetwork: true, force: true });
			const count = ctx.modelRegistry.getAll().filter((m) => m.provider === "doubleword").length;
			const error = result.errors.get("doubleword") ?? (lastError ? new Error(lastError) : undefined);
			if (error) {
				ctx.ui.notify(`Doubleword catalog refresh failed: ${error.message}`, "error");
			} else {
				await applyRefreshedCatalog(ctx);
				ctx.ui.notify(`Doubleword: ${count} models available.`, "info");
			}
		},
	});

	pi.registerCommand("doubleword-mode", {
		description: 'Show or set the Doubleword tier (default async): /doubleword-mode [realtime|async]',
		handler: async (args, ctx) => {
			const next = normMode(args?.trim() || undefined);
			if (next) mode = next;
			const applied = await ctx.modelRegistry.refresh({ providers: ["doubleword"], allowNetwork: true, force: true });
			const error = applied.errors.get("doubleword") ?? (lastError ? new Error(lastError) : undefined);
			const detail = error
				? ` (refresh failed: ${error.message} — mode applies on next successful refresh)`
				: "";
			if (!error) await applyRefreshedCatalog(ctx);
			ctx.ui.notify(
				`Doubleword tier: ${mode}${mode === "async" ? ' (sends service_tier="flex")' : ""}${detail}`,
				error ? "warning" : "info",
			);
		},
	});

	let autoRefreshed = false;
	let warnedStartupIssue = false;
	pi.on("session_start", async (_event, ctx) => {
		// The keyless /v1/models catalog can be a degraded subset; the effective
		// credential (models.json / auth.json / env) may unlock the full list.
		// Pull once per process when a session starts.
		if (!autoRefreshed) {
			autoRefreshed = true;
			try {
				const result = await ctx.modelRegistry.refresh({
					providers: ["doubleword"],
					allowNetwork: true,
					force: true,
					signal: ctx.signal,
				});
				const error = result.errors.get("doubleword") ?? (lastError ? new Error(lastError) : undefined);
				const count = ctx.modelRegistry.getAll().filter((m) => m.provider === "doubleword").length;
				if (error) {
					if (!startupHadCatalog && count === 0) {
						warnedStartupIssue = true;
						ctx.ui.notify(`Doubleword: catalog unavailable (${error.message}). Run /doubleword-refresh after /login.`, "warning");
					}
				} else if (count > 0 && !startupHadCatalog) {
					// Startup fetch failed; session refresh recovered. Re-register
					// with the fresh catalog and rebind the session model so the
					// (possibly just-selected) stale instance is replaced.
					await applyRefreshedCatalog(ctx);
					ctx.ui.notify(`Doubleword: ${count} models available.`, "info");
				}
			} catch {
				// Refresh errors land in result.errors in normal operation.
			}
		}

		// Surface a startup failure once when the refresh above produced nothing.
		if (startupError && !warnedStartupIssue && !startupHadCatalog) {
			const count = ctx.modelRegistry.getAll().filter((m) => m.provider === "doubleword").length;
			if (count === 0) {
				warnedStartupIssue = true;
				ctx.ui.notify(`Doubleword: no catalog yet (${startupError}). Run /doubleword-refresh after login.`, "warning");
			}
		}
	});
}
