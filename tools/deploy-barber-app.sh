#!/usr/bin/env bash
#
# deploy-barber-app.sh — deploys the barber app's backend to the hosted Supabase project.
#
# Usage:
#   tools/deploy-barber-app.sh --dry-run          print every command, run nothing that writes
#   CONFIRM_PROD=1 tools/deploy-barber-app.sh     run them (from a terminal)
#
# Steps (each one is safe to repeat):
#   1. supabase link        only if this checkout is not linked to PROJECT_REF
#   2. supabase migration list --linked, then supabase db push without --yes, so the CLI
#      lists the pending migrations (0022_barber_app.sql) and asks before applying them.
#   3. supabase functions deploy staff-admin and notify-booking-event
#   4. supabase secrets set --env-file <mode-600 temp file> with APNS_KEY_ID, APNS_TEAM_ID,
#      APNS_PRIVATE_KEY (read from APNS_KEY_FILE, the .p8 from Apple) and APNS_TOPIC when
#      given. Without them existing secrets are left alone and `supabase secrets list`
#      shows which are missing (without them the push function runs dry: logs, sends nothing).
#   5. Vault: 'notify-booking-event-url' (this project's function URL) and
#      'notify-booking-event-key' (the service role key), created or updated. The trigger
#      on booking_events posts to the function only when both exist.
#   6. The manager's login: creates MANAGER_EMAIL through the Auth admin API with a
#      temporary password, prints the password once, and writes the staff row
#      (role manager, must change the password on first sign-in). If the login already
#      exists, only the staff row is made sure of; nothing is printed.
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
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

CONFIRM="${CONFIRM_PROD:-}"

# tools/.env.local first; values already in the environment are put back over it.
ENV_VARS=(SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY MANAGER_EMAIL MANAGER_NAME
          APNS_KEY_ID APNS_TEAM_ID APNS_KEY_FILE APNS_TOPIC PROJECT_REF)
if [[ -f "$ENV_FILE" ]]; then
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
PROJECT_URL="https://$PROJECT_REF.supabase.co"
FUNCTIONS=(staff-admin notify-booking-event)
VAULT_URL_NAME="notify-booking-event-url"
VAULT_KEY_NAME="notify-booking-event-key"
MANAGER_NAME="${MANAGER_NAME:-Ali}"

if [[ $DRY_RUN -eq 0 && "$CONFIRM" != "1" ]]; then
  echo "Refusing to deploy to $PROJECT_REF without CONFIRM_PROD=1 (or use --dry-run)." >&2
  exit 1
fi
if [[ $DRY_RUN -eq 0 && ! -t 0 ]]; then
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

EMAIL_RE='^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
MANAGER_EMAIL="$(printf '%s' "${MANAGER_EMAIL:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [[ -z "$MANAGER_EMAIL" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "ERROR: MANAGER_EMAIL is not set (the manager's sign-in email for the app)." >&2
    exit 1
  fi
  MANAGER_EMAIL="<MANAGER_EMAIL>"
elif [[ ! "$MANAGER_EMAIL" =~ $EMAIL_RE ]]; then
  echo "ERROR: MANAGER_EMAIL is not an email address: $MANAGER_EMAIL" >&2
  exit 1
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
  if [[ ! -f "$APNS_KEY_FILE" ]] || ! grep -q 'BEGIN PRIVATE KEY' "$APNS_KEY_FILE"; then
    echo "ERROR: APNS_KEY_FILE is not a .p8 private key: $APNS_KEY_FILE" >&2
    exit 1
  fi
  APNS_KEY="$(awk 'NF {printf "%s\\n", $0}' "$APNS_KEY_FILE")"
  APNS_SET=1
fi

SECRET_VALUES=()
[[ "$SERVICE_KEY" != "<SUPABASE_SERVICE_ROLE_KEY>" ]] && SECRET_VALUES+=("$SERVICE_KEY")
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

cd "$REPO_DIR"

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

# 5. Vault: where the booking_events trigger posts, and with which key
VAULT_SQL="do \$vault\$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = '$VAULT_URL_NAME';
  if v_id is null then
    perform vault.create_secret('$PROJECT_URL/functions/v1/notify-booking-event', '$VAULT_URL_NAME',
                                'notify-booking-event function URL for the booking_events trigger');
  else
    perform vault.update_secret(v_id, '$PROJECT_URL/functions/v1/notify-booking-event');
  end if;
  select id into v_id from vault.secrets where name = '$VAULT_KEY_NAME';
  if v_id is null then
    perform vault.create_secret('$SERVICE_KEY', '$VAULT_KEY_NAME',
                                'service_role key for the booking_events push trigger');
  else
    perform vault.update_secret(v_id, '$SERVICE_KEY');
  end if;
end
\$vault\$;"
query_file "$VAULT_SQL"

# 6. The manager's login
TEMP_PASSWORD=""
echo "+ POST $PROJECT_URL/auth/v1/admin/users  (email $MANAGER_EMAIL, email_confirm true, temporary password)"
if [[ $DRY_RUN -eq 0 ]]; then
  command -v deno >/dev/null || { echo "ERROR: deno is needed to make the temporary password." >&2; exit 1; }
  TEMP_PASSWORD="$(cd "$REPO_DIR" && deno eval --no-lock \
    "import { temporaryPassword } from './supabase/functions/staff-admin/admin.ts'; console.log(temporaryPassword());")"
  SECRET_VALUES+=("$TEMP_PASSWORD")
  BODY="$(MANAGER_EMAIL="$MANAGER_EMAIL" MANAGER_NAME="$MANAGER_NAME" TEMP_PASSWORD="$TEMP_PASSWORD" python3 -c '
import json, os
print(json.dumps({"email": os.environ["MANAGER_EMAIL"], "password": os.environ["TEMP_PASSWORD"],
                  "email_confirm": True, "user_metadata": {"display_name": os.environ["MANAGER_NAME"]}}))')"
  body_file="$(temp_file "$BODY")"
  TMP_FILES+=("$body_file")
  hdr_file="$(temp_file "apikey: $SERVICE_KEY
Authorization: Bearer $SERVICE_KEY
Content-Type: application/json")"
  TMP_FILES+=("$hdr_file")
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PROJECT_URL/auth/v1/admin/users" \
    -H "@$hdr_file" --data-binary "@$body_file")"
  rm -f "$body_file" "$hdr_file"
  case "$STATUS" in
    200|201) echo "# login $MANAGER_EMAIL created" ;;
    422) echo "# login $MANAGER_EMAIL already exists: password unchanged (reset it from the app, Barbers -> login)"
         TEMP_PASSWORD="" ;;
    *) echo "ERROR: creating $MANAGER_EMAIL failed with HTTP $STATUS" >&2; exit 1 ;;
  esac
fi

STAFF_SQL="insert into staff (user_id, role, barber_id, display_name, must_change_password)
select u.id, 'manager', null, '${MANAGER_NAME//\'/\'\'}', true
  from auth.users u
 where u.email = '$MANAGER_EMAIL'
on conflict (user_id) do update set role = 'manager';
select u.email, s.role, s.display_name, s.must_change_password
  from staff s join auth.users u on u.id = s.user_id
 where u.email = '$MANAGER_EMAIL';"
query_file "$STAFF_SQL"

# 7. Checklist
cat <<EOF

# Checklist (dashboard only, $PROJECT_REF):
#   [ ] Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
#       The app has no sign-up; logins are made by the manager. A self-made login has no staff row and
#       sees nothing, but it is still 'authenticated', and confirm_booking (0001) is granted to that role.
#   [ ] Authentication -> Email: leave email confirmation on; staff-admin confirms its own users.
#   [ ] Edge Functions: staff-admin and notify-booking-event show as deployed.
#   [ ] APNs: Apple Developer -> Keys -> an APNs key for team 9X79V37Q89; set APNS_KEY_ID, APNS_TEAM_ID,
#       APNS_KEY_FILE and run this again. Until then pushes run dry (function logs only).
#   [ ] Storage: the barber-photos bucket exists and is public.
EOF

if [[ -n "$TEMP_PASSWORD" ]]; then
  cat <<EOF

# Manager login for the app (shown once, change it at first sign-in):
#   email     $MANAGER_EMAIL
#   password  $TEMP_PASSWORD
EOF
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# dry run: nothing was executed"
else
  echo "# done. Pushes: supabase db query --linked \"select status_code, content from net._http_response order by id desc limit 5;\""
fi
