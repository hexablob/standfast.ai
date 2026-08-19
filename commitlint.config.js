// commitlint.config.js
//
// The convention is not new. CONTRIBUTING.md has asked for Conventional Commits
// from the start and every commit on main already conforms; this file is the
// enforcement, not the decision. A convention that only a document states is a
// convention that decays.
//
// Checked in two places: .githooks/commit-msg before the message is written,
// and the `commit messages` job in CI over the whole pull request range. The
// hook is where it costs the least to fail; CI is what makes it true for
// people who ran `pnpm install --ignore-scripts` or passed --no-verify.

export default {
  extends: ["@commitlint/config-conventional"],

  rules: {
    // The seven types CONTRIBUTING.md names, and no others. config-conventional
    // ships eleven — `build`, `perf`, `style` and `revert` are dropped because
    // nothing here has needed them, and an unused type is a second place a
    // change can go. Adding one means editing CONTRIBUTING.md in the same
    // commit: the list has one home, and this rule is what keeps it that way.
    // Git's own `Revert "..."` messages are ignored by commitlint before any
    // rule runs, so dropping `revert` does not break `git revert`.
    "type-enum": [
      2,
      "always",
      ["chore", "ci", "docs", "feat", "fix", "refactor", "test"],
    ],

    // config-conventional also forbids sentence-case, which it detects as
    // nothing more than a capital first letter — so it rejects any subject
    // opening on a proper noun. `feat(mcp): Standfast MCP server with the three
    // phase-0 tools` is already on main and fails it. A rule that cannot
    // express the product's own name is measuring the wrong thing; the three
    // that remain still catch `FIX: BROKEN` and `feat: Add The Thing`.
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],

    // Off, not relaxed. Dependabot pastes release notes and bare URLs into the
    // body, and a URL cannot be wrapped. A width rule here would fail every
    // dependency pull request for a defect none of them has. The header is
    // still capped, which is the line that shows up in `git log --oneline`.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],

    // Off because it is wrong here more often than it is right: five of the
    // twenty commits on main trip it. Prose wrapped at eighty columns lands a
    // word before a colon at the start of a line, the parser reads that as the
    // first footer token, and it then complains that the body above it is not
    // blank. A warning that cries wolf a quarter of the time teaches people to
    // skim past the ones that do not.
    "footer-leading-blank": [0],
  },

  // Considered and declined: scope-enum. Pinning scopes to the workspace
  // package names would reject `chore(deps)` from Dependabot and `docs(06)`
  // from a documentation change, and the failure mode it prevents — a typo in a
  // scope — is visible in review and harmless in history.
};
