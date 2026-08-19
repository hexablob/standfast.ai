# labels

One file per (document, labeller): `<document id, / replaced by __>.<labeller>.json`.

Start one with:

```bash
pnpm eval skeleton self/02-principles ana
```

then fill in `expect` for each section **before looking at any extractor
output**. `pnpm eval check` validates every file here: it refuses a quote that is
not in the section body, refuses the same section labelled twice, and names any
section whose hash moved under the labels as needing re-labelling.

Two labellers on the same document is what produces an agreement figure. A
precision number with no agreement number beside it is a statement about one
person's taste.

See [`../README.md`](../README.md) for the labelling procedure and the four
contamination rules, and [`docs/12-evaluation.md`](../../docs/12-evaluation.md)
for why they exist.

This directory is empty of labels. It is tracked so it exists before anyone needs
it.
