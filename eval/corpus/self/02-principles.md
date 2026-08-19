# Design principles

These take precedence over implementation preference. A pull request that
breaks one must say so and justify it.

1. **The moat is verification, not storage.** Keeping a record of decisions is
   trivial. Knowing whether the code still honors them is not. Prioritize every
   engineering hour against that sentence.

2. **Privacy boundaries are enforced at the wire.** A guarantee a user can
   attempt to break and watch fail is worth more than any policy statement.
   Schema constraint, database constraint, permanent regression test.

3. **The tool budget is a product constraint.** Every tool description costs
   tokens in every session and degrades the agent's selection accuracy. Adding a
   tool is a design decision, not an addition.

4. **Determinism on the read path.** No *generative* model call between an
   agent's question and its answer: the pipeline admits only pinned, bounded
   embedding and reranking calls, and nothing that generates text. Token
   budget and p95 latency are contracts, not targets.

5. **Provisional by default.** Nothing an agent writes becomes canonical without
   human ratification. And because ratification is the real bottleneck, its
   throughput is a first-class product metric, not an interface detail.

6. **Recommender, never actor.** The system flags, proposes and annotates. It
   does not fix code, deprecate knowledge, or open pull requests.

7. **Re-derivability.** Documents are the source; atoms are a projection. When
   models improve, everything regenerates.

8. **Falsify, don't confirm.** For any verification, ask what would disprove the
   claim, never what would support it.

9. **Allowlist, never denylist**, for anything that leaves the machine.

10. **Measure before you tune.** The evaluation harness precedes optimization.
    Reconciliation false-positive rate is the kill metric: above 5%, users
    switch the feature off and never switch it back on.

11. **Anti-lock-in is a feature.** Full Markdown export to a repository the
    customer controls removes a major purchase objection for very little
    engineering.

12. **The supply chain is product surface.** Pin, sign, attest. Never execute
    the latest published version at every startup.

13. **Knowledge is an instruction channel.** A canonical atom is a directive
    injected into every future session. Treat it as a security surface:
    provenance surfaced, imperative and meta patterns flagged, human
    ratification as the central control.

## Anti-patterns

Do not accumulate MCP tools as needs arise. Do not put a generative model call
on a hot path. Do not let an agent promote its own knowledge. Do not mistake vector
similarity for claim identity. Do not tune a threshold without a labelled
corpus. Do not return a truncated result set without telling the agent it was
truncated.
