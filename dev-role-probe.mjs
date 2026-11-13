#!/usr/bin/env node
// dev-role-probe.mjs — Does your "OpenAI-compatible" endpoint honor the `developer` role?
//
// Usage:
//   MODEL=provider/model node dev-role-probe.mjs
//   BASE_URL=https://api.yourhost.com/v1 MODEL=your/model API_KEY=sk-... node dev-role-probe.mjs
//   (defaults: BASE_URL=https://api.doubleword.ai/v1; without API_KEY, falls back to
//    Doubleword's apiKey in ~/.pi/agent/models.json — custom endpoints require
//    an explicit API_KEY)
//
// Sends the same unique instruction twice — once as `system`, once as `developer` —
// then asks the model to recall it. A per-run nonce means a correct answer PROVES the
// message was delivered; luck is impossible. A FAIL that disappears on retry means the
// model refused/confused, not that delivery broke — so each role gets one retry.
//
// Verdicts:
//   both PASS                          → good
//   system PASS + developer FAIL       → developer-role instruction handling failed
//                                        (HTTP 200, instructions not followed; server-side
//                                         cause not established by this test. Client fix:
//                                         send 'system' instead, e.g. pi model compat
//                                         { supportsDeveloperRole: false })
//   system FAIL even after retry       → deeper issue (auth, body format, or the model)
//
// Zero dependencies.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE_URL = (process.env.BASE_URL ?? "https://api.doubleword.ai/v1").replace(/\/+$/, "");
const MODEL = process.env.MODEL; // required
if (!MODEL) {
  console.error("Usage: BASE_URL=... MODEL=provider/model [API_KEY=sk-...] node dev-role-probe.mjs");
  process.exit(1);
}
// Credential policy: this probe only reads a stored credential when it is
// talking to the default Doubleword endpoint. With a custom BASE_URL, send an
// explicit API_KEY — a stored Doubleword key must never be sent to an
// unexpected host. $ENV_NAME references in models.json are resolved.
const DEFAULT_ENDPOINT = BASE_URL === "https://api.doubleword.ai/v1";
const API_KEY =
  process.env.API_KEY ??
  (DEFAULT_ENDPOINT
    ? (() => {
        try {
          // pi users: read only Doubleword's own credential from pi's storage.
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

const CALLSIGN = `${randomBytes(3).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
const INSTRUCTION = `Your callsign for this session is ${CALLSIGN}. Remember it.`;
const FOLLOWUP = "Please output your callsign now. Only the callsign.";

async function once(instructionRole) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: instructionRole, content: INSTRUCTION },
        { role: "user", content: FOLLOWUP },
      ],
    }),
  });
  if (!res.ok) return { ok: false, note: `HTTP ${res.status}`, httpError: true };
  const json = await res.json();
  const answer = json.choices?.[0]?.message?.content?.trim() ?? "(empty)";
  // substring match: the model may apologize, code-fence, or add prose around it
  return { ok: answer.includes(CALLSIGN), note: answer.replace(/\s+/g, " ").slice(0, 70) };
}

// A FAIL here can mean (a) message never delivered, or (b) model refused/derailed.
// Delivery drops are deterministic; refusals are not — so retry once before believing it.
async function probe(instructionRole) {
  let r = await once(instructionRole);
  if (!r.ok && !r.httpError) r = await once(instructionRole);
  return r;
}

console.log(`Endpoint : ${BASE_URL}`);
console.log(`Model    : ${MODEL}`);
console.log(`Callsign : ${CALLSIGN}\n`);

const results = [];
for (const role of ["system", "developer"]) {
  const r = await probe(role);
  results.push([role, r]);
  console.log(`${role.padEnd(10)} ${r.ok ? "PASS — model recalled the callsign" : "FAIL"}  ⇢ replied: ${JSON.stringify(r.note)}`);
}

console.log("");
const sys = results.find(([role]) => role === "system")[1];
const dev = results.find(([role]) => role === "developer")[1];
if (sys.ok && dev.ok) {
  console.log(`✅ ${MODEL} receives instructions in both roles. No action needed.`);
} else if (sys.ok && dev.httpError) {
  console.log(`⛔ ${MODEL} REJECTS developer-role messages with an HTTP error.\n   Modern OpenAI-SDK clients (which send instructions as 'developer') will crash here.\n   Fix: send 'system' instead (e.g. pi: model compat { supportsDeveloperRole: false }).`);
} else if (sys.ok) {
  console.log(`⚠️  ${MODEL}: developer-role instruction handling FAILED (HTTP 200, but the model did not follow the instruction).\n   This test does not establish the server-side cause. Fix: send 'system' instead (e.g. pi: model compat { supportsDeveloperRole: false }).`);
} else {
  console.log(`❌ Instructions didn't reach the model even as 'system' — check auth / body format / model behavior.`);
}
