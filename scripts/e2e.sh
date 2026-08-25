#!/usr/bin/env bash
#
# Scripted end-to-end — phase 4 exit criterion 1 (docs/14-roadmap.md).
#
# One script, run identically by a human locally and by CI: build, migrate,
# bootstrap an org, start the real API and the real worker on deterministic
# fakes, sync a document, watch extraction propose an atom, ratify it as a
# human would, and prove a SessionStart hook receives it in the context pack.
#
# Requires: DATABASE_URL (a superuser connection to an empty or e2e-dedicated
# database). Everything else is derived. Example:
#
#   DATABASE_URL=postgres://postgres:standfast@localhost:55432/standfast_e2e_db \
#     scripts/e2e.sh
#
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (superuser) is required}"

API_PORT="${E2E_API_PORT:-38080}"
SENTINEL="walrus-shaped rate limiter caps retries at eleven per fortnight"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Deterministic fakes are the DEFAULT when nothing is configured. The worker
# refuses an egress allowlist backed by fakes (packages/worker/src/main.ts),
# so these are unset, never set. DIRECT_URL is unset because every db script
# prefers it over DATABASE_URL and a developer shell may carry one. The
# STANDFAST_API_KEY/BASE_URL/PROJECT_ID trio is unset so a logged-in
# developer's environment cannot leak into the run; the script sets its own.
unset STANDFAST_EXTRACTION_MODEL STANDFAST_EMBEDDING_MODEL \
  STANDFAST_JUDGE_MODEL STANDFAST_EGRESS_ALLOWLIST \
  STANDFAST_EXTRACTION_PROMPT_VERSION STANDFAST_EMBEDDING_PROVIDER \
  STANDFAST_API_KEY STANDFAST_BASE_URL STANDFAST_PROJECT_ID DIRECT_URL

API_PID=""
WORKER_PID=""

cleanup() {
  local code=$?
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT

die() {
  echo "E2E FAIL: $*" >&2
  exit 1
}

step() {
  echo "--- $*" >&2
}

# --- install and build (the same commands .github/workflows/ci.yml uses) ----
if [ "${CI:-false}" = "true" ] || [ ! -d node_modules ]; then
  step "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi
step "build (tsc -b)"
pnpm exec tsc -b

# --- database: migrate, install the queue (superuser) ----------------------
step "migrations"
pnpm db:migrate
step "queue install"
pnpm db:queue:install

# --- the app role -----------------------------------------------------------
# The API and worker refuse a superuser connection (assertTenantIsolationApplies):
# a superuser bypasses RLS and the system would look healthy with no tenant
# isolation at all. Same shape as packages/db/src/testing/harness.ts.
step "create app role standfast_e2e"
(cd packages/db && node --input-type=module <<'NODE'
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(`DO $do$ BEGIN
  CREATE ROLE standfast_e2e LOGIN PASSWORD 'standfast_e2e' NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;`);
await c.query('GRANT "standfast_app" TO standfast_e2e');
await c.end();
NODE
)

APP_DATABASE_URL="$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  u.username = "standfast_e2e";
  u.password = "standfast_e2e";
  process.stdout.write(u.toString());
')"

# --- bootstrap an org and scrape the API key from stderr --------------------
# The key is shown once, on stderr; only its SHA-256 is stored.
step "bootstrap org"
BOOTSTRAP_LOG="$(node packages/db/dist/bootstrap.js "e2e-$(date +%s)" "E2E Owner" 2>&1 >/dev/null)" ||
  die "bootstrap failed: $BOOTSTRAP_LOG"
API_KEY="$(printf '%s\n' "$BOOTSTRAP_LOG" | grep -oE 'sf_sk_[A-Za-z0-9_-]+' | head -n1)"
[ -n "$API_KEY" ] || die "no sf_sk_ key in bootstrap output: $BOOTSTRAP_LOG"

# --- spawn the API on the app connection ------------------------------------
step "start API on :$API_PORT"
DATABASE_URL="$APP_DATABASE_URL" PORT="$API_PORT" node packages/api/dist/serve.js &
API_PID=$!

api_ready=""
for _ in $(seq 1 120); do
  kill -0 "$API_PID" 2>/dev/null || die "API process exited during startup"
  if curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  sleep 0.5
done
[ -n "$api_ready" ] || die "API did not answer /health within 60s"

# --- spawn the worker (real long-running process, fakes resolve) ------------
# Mode: the real `work()` loop from packages/worker/src/main.js, exactly what
# a deployment runs. If it ever proves flaky under CI timing, the sanctioned
# fallback is a one-shot drain (packages/worker/src/drain.ts) — but prefer the
# real thing while it holds.
step "start worker"
DATABASE_URL="$APP_DATABASE_URL" node packages/worker/dist/main.js &
WORKER_PID=$!

# --- the CLI, authenticated by environment ----------------------------------
export STANDFAST_API_KEY="$API_KEY"
export STANDFAST_BASE_URL="http://localhost:$API_PORT"
cli() {
  node packages/cli/dist/bin.js "$@"
}

step "create project"
PROJECT_ID="$(cli project create "e2e" --json | jq -r '.id')"
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || die "project create returned no id"

step "sync fixture document"
# The default write path: the fixture is copied into a temp sync root — a fresh
# realpath means a fresh per-clone journal, so every run is a first run, and
# --accept records the scope digest and uploads in the same invocation.
SYNC_ROOT="$(mktemp -d)"
cp scripts/fixtures/e2e-conventions.md "$SYNC_ROOT/"
printf '{"project": "%s", "include": ["*.md"]}\n' "$PROJECT_ID" >"$SYNC_ROOT/standfast.sync.json"
cli sync "$SYNC_ROOT" --accept >/dev/null

# --- extraction: wait for the provisional atom ------------------------------
step "wait for a provisional atom"
ATOM_ID=""
for _ in $(seq 1 120); do
  kill -0 "$WORKER_PID" 2>/dev/null || die "worker process exited before extracting"
  ATOM_ID="$(cli queue --project "$PROJECT_ID" --json | jq -r '.items[0].id // empty')"
  [ -n "$ATOM_ID" ] && break
  sleep 1
done
[ -n "$ATOM_ID" ] || die "no provisional atom appeared in the queue within 120s"

# --- ratify it, as the human reviewer would ---------------------------------
step "ratify $ATOM_ID"
RATIFIED="$(cli ratify "$ATOM_ID" --json)"
STATUS="$(jq -r '.status' <<<"$RATIFIED")"
[ "$STATUS" = "canonical" ] || die "expected status canonical after ratify, got: $STATUS"

# --- SessionStart hook: the context pack must carry the ratified atom -------
# The hook exits 0 unconditionally by contract (docs/09-agent-contract.md), so
# its exit code proves nothing. The assertion is on stdout.
step "SessionStart hook"
HOOK_OUTPUT="$(printf '%s' '{"session_id":"e2e","hook_event_name":"SessionStart","source":"startup"}' |
  STANDFAST_PROJECT_ID="$PROJECT_ID" node packages/mcp/dist/hook-bin.js SessionStart)"

jq -e '.hookSpecificOutput.additionalContext | type=="string" and length>0' \
  <<<"$HOOK_OUTPUT" >/dev/null ||
  die "hook emitted no additionalContext: $HOOK_OUTPUT"

jq -r '.hookSpecificOutput.additionalContext' <<<"$HOOK_OUTPUT" |
  grep -qF "$SENTINEL" ||
  die "context pack does not contain the fixture sentence: $HOOK_OUTPUT"

echo ""
echo "E2E PASS"
echo "  project   $PROJECT_ID"
echo "  atom      $ATOM_ID (canonical)"
echo "  context   SessionStart pack contains: \"$SENTINEL\""
