<!-- docs/01-thesis.md -->
# Thesis

## The problem

Three failures stack on top of each other when coding agents work on a real
project.

**Cold start.** Every session begins from nothing. The agent rediscovers the
project's conventions, usually by violating one first and being corrected.
The correction is never retained, so the next session repeats it.

**Tool divergence.** Claude Code, Cursor, Codex and Gemini each maintain their
own reconstruction of the project. Two agents working the same repository hold
two different versions of what was decided, and neither knows it.

**Silent drift.** A documented decision stays true on paper long after the code
has stopped honoring it. Nobody notices, because nothing checks. This is the
failure that costs real money, and the only one that a Markdown file cannot fix.

The first two are retrieval problems. Give each agent the decisions that govern
the file in front of it and they largely dissolve. The third is a verification
problem, and it is the only one that justifies a product rather than a
convention. That asymmetry sets our priorities: retrieval must be excellent
because it is table stakes; verification must be excellent because it is the
reason to exist.

## What Standfast is

Standfast holds a project's decisions, conventions and constraints, serves each agent
only what governs the file or task in front of it, and records whether the code
still honors them.

Agents read the code. Standfast keeps the verdict. It never sees the source.

## The three invariants

Everything in this repository follows from these. They are not preferences.

**Atoms are a projection of documents.** Knowledge is never authored directly as
a final record. It is extracted from versioned prose, which means it can be
re-derived when models improve, and always carries a source you can cite. A
hand-minted fact with no document behind it has lost its rationale and its
verification anchor permanently.

**Everything an agent writes is born provisional.** Human ratification is what
makes the knowledge base worth querying. Remove that gate and you have a system
that confidently repeats an agent's guess back to the next agent. The review is
not friction to be optimized away — it is the mechanism that produces trust.

**Source code never leaves the machine.** Reconciliation runs inside the
customer's own agent session. What comes back is a verdict and a `path:line`
pointer, nothing else. This is enforced in the schema and in the database, not
promised in a policy.

## What Standfast is not

Not a documentation site, not a wiki, not an editor. Documents are plain
Markdown in a store, and the customer's folder remains the working surface.

Not a code analysis tool. It holds no representation of source code — no
contents, no AST, no call graph, no file tree.

Not an autonomous agent. It flags, proposes and scores. A human decides.

Not a replacement for the agent's own reasoning. The context pack informs the
work; it never gates it. When Standfast is empty or unreachable, the agent proceeds
on its own judgment.

## Who it is for

A developer or a small team running two or more coding agents against the same
repository, with project knowledge already sitting in Markdown, who has been
bitten at least once by an agent confidently contradicting a decision made three
weeks earlier.

## How we will know it works

Not by atoms stored. By four numbers: extraction precision, retrieval precision
under a fixed token budget, reconciliation false-positive rate, and ratification
throughput. See `docs/12-evaluation.md`.
