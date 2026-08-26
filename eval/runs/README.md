# runs

Committed runs. One file per measurement, and the file carries everything needed
to reproduce it: the metric, the corpus revision, the code revision, the model
name **and version**, and the configuration. None of the five is derivable from
the others — the model version especially, since it is the one input that can
change with no diff on our side.

A run is emitted with `verdict: null` on every atom. A human adjudicates each
one, then:

```bash
pnpm eval score runs/2026-08-07-extraction-self.json
```

which refuses a file with any `verdict` still null — a half-adjudicated worksheet
is not a measurement — and writes the score back into the file.

A run whose labels were not blind, or were model-assisted, says so in `labels`
and prints `CONTAMINATED` in its summary.

This directory is empty. There are no numbers yet, which is the honest state:
the extractor does not exist until phase 1c and 1d.

The one exception is `*-latency-*.json`, written by `pnpm eval latency`. That
slice measures a percentile rather than an accuracy, so it needs corpus volume
rather than human labels and can run today. It records no bar and compares to
nothing: the p95 latency contract for `context` is Open and owned by
`docs/14-roadmap.md`, and its `notAContract` field says so in every file, so a
number cannot be quoted out of this directory without its caveat.

`biome.json` here excludes generated run files from formatting, the same way
the root configuration excludes `infra/openapi/*.json` — a runner writes them
with `JSON.stringify`, and a lint rule they re-break on every run is a lint rule
nobody keeps.
