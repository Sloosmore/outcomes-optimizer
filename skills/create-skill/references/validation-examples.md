# Validation Examples

Concrete verification patterns from past campaigns, organized by the two families of verification. Reference the principles in `create-skill/SKILL.md` for the philosophy behind these patterns.

**Strength ordering within each family:** Not all patterns are equal. Within Boolean verification, External System Confirmation and Dispatch-to-Verify are the strongest anchors — they make the real system the judge. Negative Testing and Lifecycle Verification are strong supplements. Session Continuity is the narrowest. Within Scalar verification, Quantitative Scoring and Adversarial Evaluation are the strongest — mechanically reproducible, resistant to gaming. Embedding/Similarity and KPI Metrics require more interpretation. When in doubt, anchor on the stronger patterns and add weaker ones as supplements.

---

# Boolean Verification

The outcome is binary: it works or it doesn't. Code features, infrastructure changes, migrations, and integration tests live here. The question is "did it happen correctly?" — not "how well."

## Dispatch-to-Verify

Provision a separate environment and run the system in it. The provisioned environment either boots and works, or it doesn't.

- **Infrastructure self-test:** Changes to provisioning code can't be tested in the environment they already provisioned. Dispatch a headless process that provisions a fresh worktree using the changed code. If it builds, boots, and runs — the change works.
- **Disposable DB branch:** Create a Supabase branch, apply a migration, run all checks, delete the branch. The branch is real infrastructure with real constraints — not a mock — but with zero production risk.

## External System Confirmation

Make a change, then verify through an external system that the change took effect. The external system is the judge.

- **Real API call with real credentials:** curl through a proxy to Instagram Graph API. The response contains the expected username AND the header `x-credential-injected: true`. This caught missing tokens, expired credentials, and silent proxy fallback routes.
- **Database + Browser dual verification:** Write to the real DB, then use agent-browser to navigate to the UI (via query parameters) and confirm the change is reflected. Both systems must agree — neither can silently fail while the other passes.
- **Cross-process git artifact:** Parent dispatches a sub-campaign to a remote machine. The sub-campaign pushes a verification file to the parent's branch. Parent polls until the file appears. The git artifact is proof a real process ran — not just that a message was sent.

## Negative Testing

Verify that failures behave correctly. The system must reject bad input, not just accept good input.

- **RLS dual-key test:** Query the same table with anonymous credentials (expect zero rows) and service role credentials (expect real rows). If both return the same result, the security policy isn't enforced.
- **SSRF guard:** Send a request with a valid resource header but an evil target URL. The proxy must block it. Send a request with a nonexistent resource — must return `x-credential-injected: false`, not crash or silently inject.
- **Session isolation:** Send a secret to channel A. Ask channel B to recall it. Channel B must fail. This proves sessions don't leak across boundaries.

## Lifecycle Verification

Prove that both setup AND teardown work. Infrastructure leaks compound.

- **Provision → use → teardown → verify gone:** Create a resource, use it, tear it down, then verify it's actually gone. Past campaigns had teardown stubs that silently failed.
- **Fault isolation:** Intentionally fail one teardown step. Verify subsequent steps still execute and the overall process exits cleanly. One flaky component can't block all cleanup.
- **Migration idempotency:** Run the migration twice. The second run must succeed without error (via ON CONFLICT DO NOTHING or equivalent). Count rows before and after to prove no data loss.

## Session Continuity

Prove that state persists across interruptions — not just within a single cycle.

- **Three-cycle marker recall:** Plant marker M1 in cycle 1, marker M2 in cycle 2. In cycle 3, ask the agent to recall both. If it can list both exactly, transcript accumulates rather than resets.
- **Conflict routing:** Send a message with mismatched routing directives (e.g., target=main but sessionKey=sub). The system must reject or ignore the mismatch — not silently route to the wrong session.

---

# Scalar Verification

The outcome is a score on a spectrum. Content quality, visual fidelity, engagement metrics, and KPI-driven goals live here. The question is "how well?" — and the score must improve across epochs.

## Quantitative Scoring

Produce a measurable score that is mechanically reproducible and comparable across runs.

- **Asset fidelity (SSIM):** HTML-to-PowerPoint conversion evaluated with 24 metrics. SSIM (pixel similarity) was the anchor — a single number. A human saying "it looks right" is an observation. A 0.94 SSIM score is proof. The 24 metrics meant the agent couldn't game one dimension while silently degrading others.
- **Pixel-perfect layout:** Use Playwright to get bounding boxes for every rendered element. Compute pairwise intersection area. Assert: zero overlaps AND minimum element count in viewport (e.g., 40+ nodes). Quantifiable — no human judgment needed.

## Adversarial Evaluation

Use an independent system to judge quality, where the judge doesn't know which output is real.

- **Double-blind triplet test:** Give an unknowing agent three texts: one from the real person, one AI-generated, one neutral. Ask which is more like the real person. The selection rate across N trials is the score. Borrowed from triplet loss in embedding model training — one anchor, one positive, one negative.
- **AI detection inversion:** Run generated text through GPT-zero or equivalent. The goal is the LOWEST possible score (most human-like). This inverts the usual metric direction — lower is better.
- **Cross-system media verification:** Generate audio, pipe it through a speech recognition or real-time API. If the downstream system produces a coherent response, the audio is valid. The proof comes from a system that wasn't involved in creating the artifact.

## Embedding and Similarity

Compute distance in a latent space to measure how close output is to a target.

- **Voice/style fidelity:** Embed generated text and reference corpus, compute cosine similarity. A single number capturing semantic closeness to the target voice. Track across epochs — the score should converge toward the reference.
- **Multi-axis triangulation:** No single metric captures "sounds like this person." Combine embedding similarity + double-blind selection rate + AI detection score. If all three improve across epochs, the output is genuinely getting closer.

## KPI and Metric Goals

The success criterion is a real-world metric that moves over time, measured between epochs or sleep/wake cycles.

- **Engagement tracking:** Verify that view counts, likes, or engagement metrics are increasing between sleep/wake cycles. Not a single snapshot — an observable trend across multiple measurement points.
- **Multi-wave screenshot verification:** Take screenshots at multiple stages with controlled state changes between them. Wave 1: baseline render. Wave 2: spawn events, verify new elements appear. Wave 3: different events, verify elements moved. The delta between waves is the proof that the system is reactive.

---

## The Boolean-Scalar Bifurcation

Code features are mostly boolean — tests pass or fail, migrations apply or don't. Metric-driven goals are scalar — there's always a score, and the goal is to move it in a direction. This changes how verification works:

- **Boolean goals:** Verification is pass/fail. A single proof-level check is sufficient per criterion.
- **Scalar goals:** Verification is directional. The score must improve across epochs. The `metricsSchema` on the process record (`fields[].direction: maximize | minimize`) tracks this. A single snapshot is not proof — a trend is.

Both families need proof. The difference is what proof looks like.

---

*This file is a living catalog. Add new patterns as campaigns reveal them. Each entry should describe the context, the proof method, why it works, and when to reuse it.*
