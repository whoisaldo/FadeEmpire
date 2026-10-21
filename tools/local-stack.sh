#!/usr/bin/env bash
#
# local-stack.sh — the barber app's local Supabase stack. Development only: it
# never links, pushes to, or reads from the hosted project.
#
# Usage:
#   tools/local-stack.sh start       boot the VM and the stack, apply every migration on a
#                                    new database, seed it (logins + a week of bookings)
#   tools/local-stack.sh reset       re-apply every migration from scratch, then seed
#   tools/local-stack.sh test        reset, lint, run every pgTAP suite, then seed again
#                                    (so the stack is left seeded)
#   tools/local-stack.sh functions   serve the Edge Functions in the foreground with logs
#                                    (start already serves them; this is for watching them.
#                                    It replaces the stack's edge runtime: run start after it)
#   tools/local-stack.sh env         print the API URL and keys for the app
#   tools/local-stack.sh stop        stop the stack (data kept) and the VM
#
# Where it runs:
#   - Colima profile `fadeempire` (4 CPU, 6 GB, 30 GB). Every docker and supabase
#     command here uses DOCKER_HOST=unix://$HOME/.colima/fadeempire/docker.sock; the
#     default docker context belongs to another project and is never used or changed.
#     `colima start` switches the default context to the new profile, so the script
#     puts the previous context back right after.
#   - Working copy: $FE_STACK_DIR (default ~/Desktop/FadeEmpire-wt/app-stack). Colima
#     only shares $HOME with the VM; from /tmp, `supabase test db` finds no tests and
#     passes with zero. The script copies supabase/migrations, functions and tests from
#     the checkout it lives in and writes its own config.toml there, so it works the
#     same from any worktree.
#   - Project id fadeempire-app on ports 56320-56329 (API 56321, DB 56322, shadow
#     56320). 54321-54325 and 55321-55327 belong to other projects' stacks on this
#     machine and are never used. Studio, Inbucket, imgproxy, analytics, realtime,
#     postgres-meta and the pooler are off; auth, rest, storage and the edge runtime run.
#
# Seeded logins (local only), password fade-local-1:
#   ali@local.test (manager), hassan@local.test, larry@local.test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
STACK_DIR="${FE_STACK_DIR:-$HOME/Desktop/FadeEmpire-wt/app-stack}"
PROFILE="fadeempire"
PROJECT_ID="fadeempire-app"
export DOCKER_HOST="unix://$HOME/.colima/$PROFILE/docker.sock"

PORT_SHADOW=56320
PORT_API=56321
PORT_DB=56322
PORT_STUDIO=56323
PORT_INBUCKET=56324
PORT_ANALYTICS=56327
PORT_POOLER=56329
PORTS=("$PORT_SHADOW" "$PORT_API" "$PORT_DB")

PASSWORD="fade-local-1"
LOGINS=("ali@local.test:Ali" "hassan@local.test:Hassan" "larry@local.test:Larry")
EXCLUDE="studio,imgproxy,inbucket,realtime,analytics,vector,meta"

say() { printf '# %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "$STACK_DIR" in
  "$HOME"/*) ;;
  *) die "FE_STACK_DIR must be under \$HOME (Colima only shares \$HOME): $STACK_DIR" ;;
esac

sb() { supabase --workdir "$STACK_DIR" "$@"; }

# The default docker context, as the docker CLI stores it.
current_context() {
  python3 -c 'import json,os,sys
p=os.path.expanduser("~/.docker/config.json")
try: print(json.load(open(p)).get("currentContext",""))
except Exception: print("")'
}

restore_context() {
  local want="$1"
  [[ "$(current_context)" == "$want" ]] && return 0
  python3 - "$want" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.docker/config.json")
c = json.load(open(p))
if sys.argv[1]:
    c["currentContext"] = sys.argv[1]
else:
    c.pop("currentContext", None)
json.dump(c, open(p, "w"), indent="\t")
PY
  say "default docker context put back to '${want:-default}'"
}

ensure_vm() {
  if colima status "$PROFILE" >/dev/null 2>&1; then
    return 0
  fi
  local before
  before="$(current_context)"
  say "starting colima profile $PROFILE"
  if colima list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$PROFILE"; then
    colima start "$PROFILE"
  else
    colima start "$PROFILE" --cpu 4 --memory 6 --disk 30
  fi
  restore_context "$before"
}

stack_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "supabase_db_$PROJECT_ID"
}

check_ports() {
  local p
  for p in "${PORTS[@]}"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      die "port $p is in use by something else; this stack needs ${PORTS[*]}"
    fi
  done
}

write_config() {
  mkdir -p "$STACK_DIR/supabase"
  cat > "$STACK_DIR/supabase/config.toml" <<TOML
# Written by tools/local-stack.sh. Local barber-app stack only; edits are overwritten.
project_id = "$PROJECT_ID"

[api]
enabled = true
port = $PORT_API

[db]
port = $PORT_DB
shadow_port = $PORT_SHADOW
major_version = 17

[db.pooler]
enabled = false
port = $PORT_POOLER

[db.seed]
enabled = false

[studio]
enabled = false
port = $PORT_STUDIO

[local_smtp]
enabled = false
port = $PORT_INBUCKET

[realtime]
enabled = false

[analytics]
enabled = false
port = $PORT_ANALYTICS

[storage]
enabled = true

[storage.image_transformation]
enabled = false

[auth]
enabled = true
site_url = "http://127.0.0.1:$PORT_API"
# The app has no sign-up: the manager creates logins (staff-admin, admin API).
enable_signup = false

[auth.email]
enable_signup = true
enable_confirmations = false

[edge_runtime]
enabled = true
policy = "per_worker"
TOML
}

# Copies the checkout's migrations, functions and tests into the stack's working copy.
# rsync --delete keeps each directory in place: the edge runtime bind-mounts functions/.
sync() {
  mkdir -p "$STACK_DIR/supabase"
  local d
  for d in migrations functions tests; do
    mkdir -p "$STACK_DIR/supabase/$d"
    rsync -a --delete "$REPO_DIR/supabase/$d/" "$STACK_DIR/supabase/$d/"
  done
  write_config
}

# The edge runtime gets its function list when its container is created. When a
# function is missing from a running stack, recreate the containers (data stays).
refresh_functions() {
  stack_running || return 0
  local config entry name missing=0
  config="$(docker inspect "supabase_edge_runtime_$PROJECT_ID" --format '{{json .Config.Env}}' 2>/dev/null || true)"
  for entry in "$STACK_DIR"/supabase/functions/*/index.ts; do
    [[ -f "$entry" ]] || continue
    name="$(basename "$(dirname "$entry")")"
    grep -q "functions/$name/index.ts" <<<"$config" || missing=1
  done
  if [[ $missing -eq 1 ]]; then
    say "new Edge Functions: recreating the stack's containers (data kept)"
    sb stop
    sb start -x "$EXCLUDE"
  fi
}

status_env() { sb status -o env 2>/dev/null; }

env_value() {
  status_env | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" | head -1
}

db_container() { printf 'supabase_db_%s' "$PROJECT_ID"; }

psql_stack() {
  docker exec -i "$(db_container)" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"
}

# Values reach the admin API as JSON built by json.dumps and the database as psql
# variables (:'name'); none is spliced into JSON or SQL text.
seed() {
  local api service email name body status
  api="http://127.0.0.1:$PORT_API"
  service="$(env_value SERVICE_ROLE_KEY)"
  [[ -n "$service" ]] || die "could not read the local service role key from supabase status"

  for entry in "${LOGINS[@]}"; do
    email="${entry%%:*}"
    name="${entry#*:}"
    body="$(EMAIL="$email" NAME="$name" PASSWORD="$PASSWORD" python3 -c 'import json, os
print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"], "email_confirm": True,
                  "user_metadata": {"display_name": os.environ["NAME"]}}))')"
    status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/auth/v1/admin/users" \
      -H "apikey: $service" -H "Authorization: Bearer $service" -H 'Content-Type: application/json' \
      --data-binary "$body")"
    case "$status" in
      200|201) say "login $email created" ;;
      422) say "login $email already exists" ;;
      *) die "creating $email failed with HTTP $status" ;;
    esac
  done

  psql_stack < "$SCRIPT_DIR/local-stack-seed.sql"

  # Pushes: the notify trigger reaches the edge runtime through Kong on the
  # stack's docker network. Without APNS_* secrets the function logs and returns 200.
  psql_stack -v "fn_url=http://supabase_kong_$PROJECT_ID:8000/functions/v1/notify-booking-event" \
             -v "service_key=$service" <<'SQL'
\o /dev/null
select vault.create_secret(:'fn_url', 'notify-booking-event-url', 'local stack')
 where not exists (select 1 from vault.secrets where name = 'notify-booking-event-url');
select vault.create_secret(:'service_key', 'notify-booking-event-key', 'local stack')
 where not exists (select 1 from vault.secrets where name = 'notify-booking-event-key');
select vault.update_secret(s.id, :'service_key')
  from vault.secrets s where s.name = 'notify-booking-event-key';
SQL
  say "seeded: 3 logins, a week of bookings for both chairs"
}

start() {
  ensure_vm
  sync
  if stack_running; then
    say "stack already running"
    refresh_functions
  else
    check_ports
    say "starting supabase ($PROJECT_ID)"
    sb start -x "$EXCLUDE"
  fi
  if [[ "$(psql_stack -tA -c "select count(*) from auth.users where email = 'ali@local.test'")" == "0" ]]; then
    seed
  else
    say "already seeded (tools/local-stack.sh reset to start over)"
  fi
  print_env
}

reset() {
  ensure_vm
  sync
  stack_running || die "stack is not running: tools/local-stack.sh start"
  refresh_functions
  sb db reset --local
  seed
}

run_tests() {
  ensure_vm
  sync
  stack_running || die "stack is not running: tools/local-stack.sh start"
  refresh_functions
  sb db reset --local
  sb db lint --local --fail-on error
  local rc=0
  sb test db --local || rc=$?
  seed
  return $rc
}

serve_functions() {
  ensure_vm
  sync
  stack_running || die "stack is not running: tools/local-stack.sh start"
  sb functions serve
}

print_env() {
  local anon
  anon="$(env_value ANON_KEY)"
  cat <<EOF
# API      http://127.0.0.1:$PORT_API  (also http://$(tailscale ip -4 2>/dev/null | head -1 || echo devbox1):$PORT_API)
# DB       postgresql://postgres:postgres@127.0.0.1:$PORT_DB/postgres
# Anon key $anon
# Logins   ali@local.test (manager), hassan@local.test, larry@local.test — password $PASSWORD
EOF
}

stop() {
  if colima status "$PROFILE" >/dev/null 2>&1; then
    if stack_running; then sb stop; fi
    local before
    before="$(current_context)"
    colima stop "$PROFILE"
    restore_context "$before"
  fi
  say "stopped (data kept in the VM's docker volumes)"
}

case "${1:-}" in
  start) start ;;
  reset) reset ;;
  test) run_tests ;;
  functions) serve_functions ;;
  env) ensure_vm; print_env ;;
  stop) stop ;;
  *) echo "usage: $0 start|reset|test|functions|env|stop" >&2; exit 2 ;;
esac
