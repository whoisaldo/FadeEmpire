#!/usr/bin/env bash
#
# deploy-barber-app.sh — deploys the barber app's backend to the hosted Supabase project.
#
# Usage:
#   tools/deploy-barber-app.sh --dry-run          print every command, run nothing that writes
#   CONFIRM_PROD=1 tools/deploy-barber-app.sh     run them (from a terminal)
#   tools/deploy-barber-app.sh --local [--dry-run]
#                                                 step 6 only, against the local stack
#                                                 (tools/local-stack.sh): API 127.0.0.1:56321,
#                                                 SUPABASE_SERVICE_ROLE_KEY = its service role
#                                                 key; tools/.env.local is not read
#
# Steps (each one is safe to repeat):
#   1. supabase link        only if this checkout is not linked to PROJECT_REF
#   2. supabase migration list --linked, then supabase db push without --yes, so the CLI
#      lists the pending migrations (0022_barber_app.sql) and asks before applying them.
#      Then tools/service-role-check.sql: every table and RPC privilege the functions use
#      with the service role key. It only reads, and stops the deploy, before the functions
#      go out, if one is missing (the hosted project's grants partly come from Supabase's
#      old default privileges, so they are checked, not assumed).
#   3. supabase functions deploy staff-admin and notify-booking-event
#   4. supabase secrets set --env-file <mode-600 temp file> with APNS_KEY_ID, APNS_TEAM_ID,
#      APNS_PRIVATE_KEY (read from APNS_KEY_FILE, the .p8 from Apple) and APNS_TOPIC when
#      given. Without them existing secrets are left alone and `supabase secrets list`
#      shows which are missing (without them the push function runs dry: logs, sends nothing).
#   5. Vault: 'notify-booking-event-url' (this project's function URL) and
#      'notify-booking-event-key' (the service role key), created or updated. The trigger
#      on booking_events posts to the function only when both exist.
#   6. The manager's login: creates MANAGER_EMAIL through the Auth admin API with a
#      temporary password, prints the password once, and writes the staff row through
#      PostgREST (role manager, must change the password on first sign-in). If the login
#      already exists, only the staff row is made sure of; nothing is printed.
#
# No value from the environment is ever spliced into SQL or JSON text: JSON bodies are
# built by json.dumps, and the one SQL step (Vault) gets its values as hex digits
# (sql_text below), because `supabase db query` takes no bind parameters. Every value is
# also checked against a strict pattern first.
#   7. Prints the checklist of what only the dashboard can do.
#
# Environment (tools/.env.local is read first; a variable already set in the
# environment wins over the file. CONFIRM_PROD is read from the environment only):
#   SUPABASE_SERVICE_ROLE_KEY   required: the legacy service_role JWT (three dot-separated
#                               base64url parts). SUPABASE_SERVICE_KEY is accepted as a fallback.
#   MANAGER_EMAIL               required for step 6: the manager's sign-in email
#   MANAGER_NAME                optional, defaults to Ali
#   APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_FILE (path to AuthKey_XXXXXXXXXX.p8), APNS_TOPIC
#                               optional, all of the first three or none; APNS_TOPIC defaults
#                               to com.chicopeefadeempire.barbers in the function
#   PROJECT_REF                 optional, defaults to mjehfaonibgobimfiijk
#
# Turn pushes off:
#   supabase db query --linked "delete from vault.secrets where name like 'notify-booking-event-%';"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env.local"

DRY_RUN=0
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --local) LOCAL=1 ;;
    *) echo "usage: $0 [--local] [--dry-run]" >&2; exit 2 ;;
  esac
done

CONFIRM="${CONFIRM_PROD:-}"

# tools/.env.local first; values already in the environment are put back over it.
ENV_VARS=(SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY MANAGER_EMAIL MANAGER_NAME
          APNS_KEY_ID APNS_TEAM_ID APNS_KEY_FILE APNS_TOPIC PROJECT_REF)
if [[ $LOCAL -eq 0 && -f "$ENV_FILE" ]]; then
  SAVED=()
  for name in "${ENV_VARS[@]}"; do
    if [[ -n "${!name+x}" ]]; then SAVED+=("$name=${!name}"); fi
  done
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  for kv in ${SAVED[@]+"${SAVED[@]}"}; do export "${kv%%=*}=${kv#*=}"; done
fi

PROJECT_REF="${PROJECT_REF:-mjehfaonibgobimfiijk}"
if [[ ! "$PROJECT_REF" =~ ^[a-z]{20}$ ]]; then
  echo "ERROR: PROJECT_REF must be a Supabase project ref (20 lowercase letters)." >&2
  exit 1
fi
PROJECT_URL="https://$PROJECT_REF.supabase.co"
[[ $LOCAL -eq 1 ]] && PROJECT_URL="http://127.0.0.1:56321"
FUNCTIONS=(staff-admin notify-booking-event)
MANAGER_NAME="${MANAGER_NAME:-Ali}"

if [[ $LOCAL -eq 0 && $DRY_RUN -eq 0 && "$CONFIRM" != "1" ]]; then
  echo "Refusing to deploy to $PROJECT_REF without CONFIRM_PROD=1 (or use --dry-run)." >&2
  exit 1
fi
if [[ $LOCAL -eq 0 && $DRY_RUN -eq 0 && ! -t 0 ]]; then
  echo "Refusing to deploy without a terminal: supabase db push must be able to ask for confirmation." >&2
  exit 1
fi

SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_KEY:-}}"
JWT_RE='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
if [[ -z "$SERVICE_KEY" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set (needed for Vault and the manager login)." >&2
    exit 1
  fi
  SERVICE_KEY="<SUPABASE_SERVICE_ROLE_KEY>"
elif [[ ! "$SERVICE_KEY" =~ $JWT_RE ]]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not a JWT (expected three dot-separated base64url parts, eyJ...)." >&2
  echo "Use the legacy service_role key from Dashboard -> Settings -> API; the push function checks for exactly this key." >&2
  exit 1
fi

# MANAGER_EMAIL, trimmed and lowercased: a dot-atom local part (RFC 5322 atext, so
# o'connor@ is allowed) of at most 64 characters, and a domain of DNS labels with a
# letters-only top level, 254 characters in all.
ATEXT='[a-z0-9!#$%&'\''*+/=?^_`{|}~-]'
EMAIL_RE="^$ATEXT+(\\.$ATEXT+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}\$"
RAW_EMAIL="${MANAGER_EMAIL:-}"
MANAGER_EMAIL="$(printf '%s' "$RAW_EMAIL" | tr '[:upper:]' '[:lower:]')"
MANAGER_EMAIL="${MANAGER_EMAIL#"${MANAGER_EMAIL%%[![:space:]]*}"}"
MANAGER_EMAIL="${MANAGER_EMAIL%"${MANAGER_EMAIL##*[![:space:]]}"}"
EMAIL_LOCAL="${MANAGER_EMAIL%@*}"
if [[ -n "$MANAGER_EMAIL" ]] && { [[ ! "$MANAGER_EMAIL" =~ $EMAIL_RE ]] \
     || (( ${#MANAGER_EMAIL} > 254 )) || (( ${#EMAIL_LOCAL} > 64 )); }; then
  echo "ERROR: MANAGER_EMAIL is not an email address: $RAW_EMAIL" >&2
  exit 1
fi
if [[ -z "$MANAGER_EMAIL" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "ERROR: MANAGER_EMAIL is not set (the manager's sign-in email for the app)." >&2
    exit 1
  fi
  MANAGER_EMAIL="<MANAGER_EMAIL>"
fi
if [[ ! "$MANAGER_NAME" =~ ^[A-Za-z][A-Za-z\ .\'-]{0,59}$ ]]; then
  echo "ERROR: MANAGER_NAME must be letters, spaces, . ' - (1-60 characters)." >&2
  exit 1
fi

# APNs: all or nothing.
APNS_SET=0
APNS_KEY=""
if [[ -n "${APNS_KEY_ID:-}${APNS_TEAM_ID:-}${APNS_KEY_FILE:-}" ]]; then
  if [[ -z "${APNS_KEY_ID:-}" || -z "${APNS_TEAM_ID:-}" || -z "${APNS_KEY_FILE:-}" ]]; then
    echo "ERROR: set APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_FILE together." >&2
    exit 1
  fi
  if [[ ! "$APNS_KEY_ID" =~ ^[A-Z0-9]{10}$ || ! "$APNS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "ERROR: APNS_KEY_ID and APNS_TEAM_ID are 10 characters, A-Z and 0-9." >&2
    exit 1
  fi
  if [[ -n "${APNS_TOPIC:-}" && ! "$APNS_TOPIC" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then
    echo "ERROR: APNS_TOPIC must be a bundle id, e.g. com.chicopeefadeempire.barbers." >&2
    exit 1
  fi
  # Only the PEM lines of a .p8: nothing that could end the quoted value in the env file.
  if [[ ! -f "$APNS_KEY_FILE" ]] || ! grep -q 'BEGIN PRIVATE KEY' "$APNS_KEY_FILE" \
     || tr -d '\r' < "$APNS_KEY_FILE" | grep -vqE '^(-----(BEGIN|END) PRIVATE KEY-----|[A-Za-z0-9+/=]+)?$'; then
    echo "ERROR: APNS_KEY_FILE is not a .p8 private key: $APNS_KEY_FILE" >&2
    exit 1
  fi
  APNS_KEY="$(tr -d '\r' < "$APNS_KEY_FILE" | awk 'NF {printf "%s\\n", $0}')"
  APNS_SET=1
fi

# hex <value>: the value's bytes as hex digits.
hex() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n'; }

# sql_text <value>: a SQL expression that evaluates to the value. It reaches the
# query only as hex digits, which no value can break out of.
sql_text() { printf "convert_from(decode('%s', 'hex'), 'UTF8')" "$(hex "$1")"; }

SECRET_VALUES=()
if [[ "$SERVICE_KEY" != "<SUPABASE_SERVICE_ROLE_KEY>" ]]; then
  SECRET_VALUES+=("$SERVICE_KEY" "$(hex "$SERVICE_KEY")")
fi
[[ -n "$APNS_KEY" ]] && SECRET_VALUES+=("$APNS_KEY")

redact() {
  local s="$1" v
  for v in ${SECRET_VALUES[@]+"${SECRET_VALUES[@]}"}; do
    [[ -n "$v" ]] && s="${s//"$v"/***}"
  done
  printf '%s' "$s"
}

# step <command...>: print the command (secrets redacted), run it unless --dry-run.
step() {
  local cmd
  cmd="$(printf '%q ' "$@")"
  printf '+ %s\n' "$(redact "${cmd% }")"
  if [[ $DRY_RUN -eq 0 ]]; then "$@"; fi
}

TMP_FILES=()
cleanup() {
  local f
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f "$f"; done
}
trap cleanup EXIT

# temp_file <content>: writes content to a new mode-600 file, prints its path.
temp_file() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  printf '%s\n' "$1" > "$file"
  printf '%s' "$file"
}

# SQL goes through a mode-600 temp file, not the command line.
query_file() {
  local sql="$1" file
  printf '+ supabase db query --linked -f <tmpfile> <<SQL\n%s\nSQL\n' "$(redact "$sql")"
  if [[ $DRY_RUN -eq 0 ]]; then
    file="$(temp_file "$sql")"
    TMP_FILES+=("$file")
    supabase db query --linked -f "$file"
    rm -f "$file"
  fi
}

# 6, the manager's login, as a function so --local can run it alone. The login goes
# through the Auth admin API and the staff row through PostgREST, both with the service
# role key: no SQL, and every body is built by json.dumps from the environment.
TEMP_PASSWORD=""
manager_login() {
  if [[ $DRY_RUN -eq 0 ]]; then
    command -v deno >/dev/null || { echo "ERROR: deno is needed to make the temporary password." >&2; exit 1; }
    TEMP_PASSWORD="$(cd "$REPO_DIR" && deno eval --no-lock \
      "import { temporaryPassword } from './supabase/functions/staff-admin/admin.ts'; console.log(temporaryPassword());")"
    SECRET_VALUES+=("$TEMP_PASSWORD")
  fi
  # Exits 0 when the login was created (or in a dry run), 10 when it already existed.
  local rc=0
  DRY_RUN="$DRY_RUN" PROJECT_URL="$PROJECT_URL" SERVICE_KEY="$SERVICE_KEY" MANAGER_EMAIL="$MANAGER_EMAIL" \
    MANAGER_NAME="$MANAGER_NAME" TEMP_PASSWORD="$TEMP_PASSWORD" python3 - <<'PY' || rc=$?
import json, os, re, sys, urllib.error, urllib.parse, urllib.request

dry = os.environ["DRY_RUN"] == "1"
api, key = os.environ["PROJECT_URL"], os.environ["SERVICE_KEY"]
email, name = os.environ["MANAGER_EMAIL"], os.environ["MANAGER_NAME"]
password = os.environ["TEMP_PASSWORD"]
uuid_re = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def call(method, path, body=None, prefer=None, shown=None):
    """Prints the request (shown, if given, is printed instead of body), then sends it
    unless this is a dry run. Returns (status, parsed JSON or None)."""
    printed = body if shown is None else shown
    print(f"+ {method} {api}{path}" + ("" if printed is None else "  " + json.dumps(printed)), flush=True)
    if dry:
        return None, None
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(api + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, None


def find_user():
    page = 1
    while True:
        status, body = call("GET", f"/auth/v1/admin/users?page={page}&per_page=100")
        if status != 200:
            fail(f"listing logins failed with HTTP {status}")
        users = (body or {}).get("users") or []
        for user in users:
            if (user.get("email") or "").lower() == email:
                return user["id"]
        if len(users) < 100:
            return None
        page += 1


login = {"email": email, "password": password, "email_confirm": True, "user_metadata": {"display_name": name}}
status, body = call("POST", "/auth/v1/admin/users", login, shown={**login, "password": "<temporary password>"})
created = False
if dry:
    user_id = "<user id>"
elif status in (200, 201):
    user_id, created = body["id"], True
    print(f"# login {email} created")
elif status == 422 and (user_id := find_user()):
    print(f"# login {email} already exists: password unchanged (reset it from the app, Barbers -> login)")
else:
    fail(f"creating {email} failed with HTTP {status}: {json.dumps(body)}")
if not dry and not uuid_re.fullmatch(user_id):
    fail(f"the Auth API returned an unexpected user id: {user_id!r}")

# The staff row: added when missing, then made a manager (an existing row keeps its
# name and password flag), then read back.
match = "user_id=eq." + urllib.parse.quote(user_id)
row = {"user_id": user_id, "role": "manager", "barber_id": None, "display_name": name, "must_change_password": True}
for method, path, payload, prefer in (
    ("POST", "/rest/v1/staff?on_conflict=user_id", row, "resolution=ignore-duplicates,return=minimal"),
    ("PATCH", f"/rest/v1/staff?{match}", {"role": "manager"}, "return=minimal"),
):
    status, body = call(method, path, payload, prefer)
    if not dry and status not in (200, 201, 204):
        fail(f"writing the staff row failed with HTTP {status}: {json.dumps(body)}")
status, rows = call("GET", f"/rest/v1/staff?{match}&select=role,display_name,must_change_password")
if not dry:
    if status != 200 or not rows or len(rows) != 1:
        fail(f"reading the staff row back failed with HTTP {status}")
    print(f"# staff row: {email} | {rows[0]['role']} | {rows[0]['display_name']} | "
          f"must change password: {str(rows[0]['must_change_password']).lower()}")
sys.exit(0 if created or dry else 10)
PY
  case $rc in
    0) ;;
    10) TEMP_PASSWORD="" ;;
    *) exit 1 ;;
  esac
}

print_password() {
  if [[ -n "$TEMP_PASSWORD" ]]; then
    cat <<PW

# Manager login for the app (shown once, change it at first sign-in):
#   email     $MANAGER_EMAIL
#   password  $TEMP_PASSWORD
PW
  fi
}

cd "$REPO_DIR"

if [[ $LOCAL -eq 1 ]]; then
  echo "# --local: step 6 only, against the local stack at $PROJECT_URL"
  manager_login
  print_password
  [[ $DRY_RUN -eq 1 ]] && echo "# dry run: nothing was executed"
  exit 0
fi

# 1. Link
LINKED=0
if [[ "$(cat supabase/.temp/project-ref 2>/dev/null || true)" == "$PROJECT_REF" ]]; then
  LINKED=1
  echo "# already linked to $PROJECT_REF"
else
  step supabase link --project-ref "$PROJECT_REF"
fi

# 2. Pending migrations, then the push (the CLI asks before applying)
echo "+ supabase migration list --linked"
if [[ $DRY_RUN -eq 0 || $LINKED -eq 1 ]]; then
  supabase migration list --linked
  echo "# pending: rows with a Local version and an empty Remote column"
else
  echo "# not linked yet: the list is shown in the real run, after linking"
fi
step supabase db push --linked

echo "+ supabase db query --linked -f tools/service-role-check.sql"
if [[ $DRY_RUN -eq 0 || $LINKED -eq 1 ]]; then
  if ! supabase db query --linked -f tools/service-role-check.sql; then
    echo "ERROR: service_role lacks a privilege the Edge Functions use (above). Grant it in a migration." >&2
    exit 1
  fi
  echo "# service_role has every privilege the functions use"
else
  echo "# not linked yet: the real run checks service_role's privileges after the push"
fi

# 3. Functions. JWT verification stays on: staff-admin gets the manager's JWT, the push
#    function gets the service role key (and checks for exactly that key itself).
for fn in "${FUNCTIONS[@]}"; do
  step supabase functions deploy "$fn" --project-ref "$PROJECT_REF"
done

# 4. APNs secrets, through a mode-600 env file
if [[ $APNS_SET -eq 1 ]]; then
  SECRET_LINES=("APNS_KEY_ID=$APNS_KEY_ID" "APNS_TEAM_ID=$APNS_TEAM_ID" "APNS_PRIVATE_KEY=\"$APNS_KEY\"")
  [[ -n "${APNS_TOPIC:-}" ]] && SECRET_LINES+=("APNS_TOPIC=$APNS_TOPIC")
  SECRETS="$(printf '%s\n' "${SECRET_LINES[@]}")"
  printf '+ supabase secrets set --project-ref %s --env-file <tmpfile>\n' "$PROJECT_REF"
  redact "$SECRETS" | sed 's/^/#   /'
  echo
  if [[ $DRY_RUN -eq 0 ]]; then
    file="$(temp_file "$SECRETS")"
    TMP_FILES+=("$file")
    supabase secrets set --project-ref "$PROJECT_REF" --env-file "$file"
    rm -f "$file"
  fi
else
  echo "# No APNS_* given: existing secrets left unchanged"
  echo "+ supabase secrets list --project-ref $PROJECT_REF"
  if [[ $DRY_RUN -eq 0 || $LINKED -eq 1 ]]; then
    if LISTED="$(supabase secrets list --project-ref "$PROJECT_REF" 2>&1)"; then
      MISSING=""
      for name in APNS_KEY_ID APNS_TEAM_ID APNS_PRIVATE_KEY; do
        grep -qw "$name" <<<"$LISTED" || MISSING="$MISSING $name"
      done
      if [[ -z "$MISSING" ]]; then
        echo "# APNs secrets exist on $PROJECT_REF: the function sends pushes"
      else
        echo "# APNs secrets missing on $PROJECT_REF:$MISSING. The push function runs dry"
      fi
    else
      echo "# could not list secrets; check them in the dashboard (Edge Functions -> Secrets)"
    fi
  else
    echo "# not linked yet: the real run lists the secrets and says whether pushes send or run dry"
  fi
fi

# 5. Vault: where the booking_events trigger posts, and with which key. The two values
#    go in through sql_text (hex digits), never as text inside the SQL.
FUNCTION_URL="$PROJECT_URL/functions/v1/notify-booking-event"
echo "# Vault values: url $FUNCTION_URL, key $(redact "$SERVICE_KEY")"
VAULT_SQL="do \$vault\$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'notify-booking-event-url';
  if v_id is null then
    perform vault.create_secret($(sql_text "$FUNCTION_URL"), 'notify-booking-event-url',
                                'notify-booking-event function URL for the booking_events trigger');
  else
    perform vault.update_secret(v_id, $(sql_text "$FUNCTION_URL"));
  end if;
  select id into v_id from vault.secrets where name = 'notify-booking-event-key';
  if v_id is null then
    perform vault.create_secret($(sql_text "$SERVICE_KEY"), 'notify-booking-event-key',
                                'service_role key for the booking_events push trigger');
  else
    perform vault.update_secret(v_id, $(sql_text "$SERVICE_KEY"));
  end if;
end
\$vault\$;"
query_file "$VAULT_SQL"

# 6. The manager's login
manager_login

# 7. Checklist
cat <<EOF

# Checklist (dashboard only, $PROJECT_REF):
#   [ ] Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
#       The app has no sign-up; logins are made by the manager. A self-made login has no staff row and
#       sees nothing, but it is still 'authenticated' and can call whatever that role may.
#   [ ] Authentication -> Email: leave email confirmation on; staff-admin confirms its own users.
#   [ ] Edge Functions: staff-admin and notify-booking-event show as deployed.
#   [ ] APNs: Apple Developer -> Keys -> an APNs key for team 9X79V37Q89; set APNS_KEY_ID, APNS_TEAM_ID,
#       APNS_KEY_FILE and run this again. Until then pushes run dry (function logs only).
#   [ ] Storage: the barber-photos bucket exists and is public.
EOF

print_password

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# dry run: nothing was executed"
else
  echo "# done. Pushes: supabase db query --linked \"select status_code, content from net._http_response order by id desc limit 5;\""
fi
