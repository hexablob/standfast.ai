# The standfast.ai site

Next.js, statically exported. Every page is prerendered to HTML at build time
and the whole site can be served from a bucket.

```bash
pnpm --filter @standfast/web dev     # http://localhost:3000
pnpm --filter @standfast/web build   # writes ./out
```

It imports no workspace package and is not in the `tsc -b` graph, so a
front-end dependency cannot reach `api`, `core`, `db` or `worker`. It makes no
request to a third party at runtime — the font is downloaded at build time and
served from this origin, and there is no analytics, no embed and no script from
anywhere else.

`src/lib/site.ts` holds every fact that appears on more than one page. Anything
stated about the product's status is read out of `docs/14-roadmap.md`; when a
phase moves, that file and this one move together.

`src/app/globals.css` is the whole design system — colour, type, radius and
spacing tokens, in one `@theme` block. Components use those tokens and add no
values of their own. Biome does not parse Tailwind's `@theme`, so the file is
excluded from lint in the root `biome.json`; keep it tidy by hand.
