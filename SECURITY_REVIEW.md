# Security and quality review: pi-doubleword

*Public repository review · November 13, 2026 · reviewed before publication*

> **Post-review update (2026-11-13):** all six findings were addressed in the same day:
>
> 1. **Credential fallback removed** from both probe scripts — a stored credential is read
>    *only* for the default `https://api.doubleword.ai/v1` endpoint; a custom `BASE_URL`
>    now requires an explicit `API_KEY`, and the scripts refuse to run otherwise instead of
>    silently sending a stored Doubleword key elsewhere. `$ENV_NAME` indirection in
>    `models.json` is resolved rather than transmitted literally.
> 2. **.gitignore hardened** — local credential/config patterns (`.env*`, keys, `auth.json`,
>    `models.json`, …) added (none had ever been committed).
> 3. **README claims corrected** — wording now distinguishes observed behavior
>    (HTTP 200, instructions not followed via `developer`, followed via `system`) from the
>    unknown server-side cause; probe verdict text updated to match ("developer-role
>    instruction handling failed", not "silently drops").
> 4. **Publishing details fixed** — a stray "November 2025" corrected to 2026 (matching the
>    benchmark logs), the `mode.flipping` typo fixed, and the install snippet pinned to a
>    commit SHA instead of a moving `main`.
> 5. **Pricing parser hardened** — when no tariff parses, the extension now reports
>    **unknown** pricing (NaN cost, rendered as no number in pi's UI) instead of a
>    misleading $0; the magnitude heuristic for per-token vs per-1M units is documented as
>    a heuristic in the code.
> 6. **CI added** — GitHub Actions runs `node --check` on both scripts and a strict
>    `tsc --noEmit` typecheck of the extension against the published
>    `@earendil-works/pi-coding-agent` package on every push. (The typecheck caught and
>    fixed two latent type errors on its first run.)
>
> **Full-history credential audit:** all git objects in the pushed history
> (3 commits, 15 objects — the complete set a fresh clone contains) were scanned for the
> live credential and for generic key-shaped literals: no hits. A `gitleaks git --log-opts="--all" --redact .`
> run from a fresh clone is still the belt-and-braces confirmation.

---

No exposed secret found

I reviewed the public files in konarkmodi/pi-doubleword, including the TypeScript extension, both benchmark scripts, README, companion guide, article, .gitignore, and the visible commit history.

I did not find an obvious live API key, password, private key, or credential dump in the published files. The dw-sk-... examples are placeholders.

I also didn't find malicious code, hidden data collection, or an unexpected external destination in the source I inspected. The extension makes API requests to Doubleword or the endpoint configured by the user.

However, I found several things I would correct before encouraging other developers to install it.

## Findings

| Severity | Finding | Recommendation |
| --- | --- | --- |
| Medium | Credential fallback in probe script | Restrict which provider's key is used |
| Medium | Weak .gitignore | Add credential and local configuration patterns |
| Low | Overconfident README claims | Match wording to what the probes establish |
| Low | Inconsistent benchmark dates | Correct November 2025 reference |
| Low | Pricing parser can misclassify units | Use explicit units and fail visibly |
| Low | No test suite or CI | Add basic automated checks |

### 1. Credential handling in dev-role-probe.mjs

**Medium priority · Security hardening**

The script resolved its API key using:

```js
const provider = process.env.PROVIDER ?? MODEL.split("/")[0];

return models?.providers?.[provider]?.apiKey
  ?? models?.providers?.doubleword?.apiKey;
```

Two problems. First, the provider was inferred from the model name — `zai-org/GLM-5.3-Flash` begins with `zai-org`, which is not necessarily the configured API provider. Second, the script silently fell back to Doubleword's key even when `BASE_URL` pointed somewhere else: someone testing a different gateway could accidentally send their Doubleword credential to that endpoint.

**Fix applied:** use `API_KEY` explicitly whenever a custom `BASE_URL` is supplied; for the default Doubleword endpoint, read only Doubleword's configured credential; resolve `$ENV_NAME` references rather than sending them literally; refuse to run without an explicit key on a custom endpoint. The same policy was applied to `flex-bench.mjs`.

### 2. Improve .gitignore

**Medium priority · Preventive**

Applied (no sensitive files had been committed). `.gitignore` doesn't protect files already committed to Git — verified likewise.

### 3. Fix the README's instruction-handling claims

**Low priority · Technical accuracy**

Applied — the article was more precise than the README; the README now matches it, and the probe's verdict line reports the observable outcome rather than asserting where the message died.

### 4. Correct two small publishing issues

**Low priority**

Fixed: the November 2025 date fragment (benchmark logs confirm 2026), the `execution mode.flipping` typo, and — beyond the review — the install instruction now pins a commit SHA, since pi executes extensions and installing code from a moving `main` is a policy decision users didn't make.

### 5. Pricing parser deserves a few tests

**Low priority · Correctness**

Partial hardening applied: `costFor()` now yields an explicit *unknown-pricing* state (NaN) with a comment chain explaining the magnitude heuristic, instead of a misleading $0. True unit-explicit parsing awaits a provider that publishes units; the full test suite remains future work (CI's strict typecheck covers the regression surface today).

### 6. Historical secret exposure

No indication of a deliberately committed-and-removed credential. A deterministic scan over **all git objects in the pushed history** (the complete set a fresh clone would contain) found no live credential and no key-shaped literal. For belt-and-braces:

```bash
git clone https://github.com/konarkmodi/pi-doubleword.git
cd pi-doubleword
gitleaks git --log-opts="--all" --redact .
```

(If it ever reports a real credential: rotate it even if the offending commit has since been deleted.)

## Overall verdict

| Dimension | Assessment |
| --- | --- |
| Secret exposure in reviewed public files | None found |
| Credential-handling safety | Needs hardening → **hardened** |
| Code quality | Good for a small utility |
| Documentation | Good, with minor corrections → **corrected** |

> *"One final observation: the repository is refreshingly small. A single extension, two diagnostic scripts, and clear documentation make it easy for developers to understand what they're installing. That's worth preserving rather than introducing unnecessary dependencies."*
