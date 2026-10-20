#!/usr/bin/env bash
#
# deploy-reminders.sh — deploys SMS reminders to the hosted Supabase project.
#
# Usage:
#   tools/deploy-reminders.sh --dry-run          print every command, run nothing that writes
#   CONFIRM_PROD=1 tools/deploy-reminders.sh     run them
#
# Steps (each one is safe to repeat):
#   1. supabase link        only if this checkout is not linked to PROJECT_REF
#   2. supabase migration list --linked, printed before the push; then supabase db push.
#      The push runs only when CONFIRM_PROD=1 and the list was shown in this run. The
#      dry run prints the list too when the checkout is already linked (read-only);
#      otherwise it prints the command.
#   3. supabase functions deploy send-reminders
#   4. supabase secrets set --env-file <mode-600 temp file> with TWILIO_* (+ SITE_URL),
#      so no secret is on a command line. The file is deleted afterwards. Skipped when
#      no TWILIO_* variable is set; the function then runs dry (logs messages, sends
#      and marks nothing).
#   5. Stores the service role key in Supabase Vault as 'send-reminders-service-key'
#      (created, or updated if present), then cron.schedule('send-reminders', hourly)
#      calling the function through pg_net. The job reads the key from
#      vault.decrypted_secrets when it runs, so cron.job and cron.job_run_details hold
#      no key. Re-running updates the secret and replaces the job of the same name.
#
# Environment (tools/.env.local is read first; a variable already set in the
# environment, e.g. `TWILIO_FROM=... tools/deploy-reminders.sh`, wins over the file.
# CONFIRM_PROD is read from the environment only, never from the file):
#   SUPABASE_SERVICE_ROLE_KEY   required for step 5: the legacy service_role JWT (three
#                               dot-separated base64url parts); the function only accepts
#                               this key. SUPABASE_SERVICE_KEY is accepted as a fallback.
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID
#   SITE_URL                    optional, defaults to https://chicopeefadeempire.com
#   PROJECT_REF                 optional, defaults to mjehfaonibgobimfiijk
#
# Turn it off:
#   supabase db query --linked "select cron.unschedule('send-reminders');"
#   supabase db query --linked "delete from vault.secrets where name = 'send-reminders-service-key';"

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
ENV_VARS=(SUPABASE_SERVICE_ROLE_KEY SUPABASE_SERVICE_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN
          TWILIO_FROM TWILIO_MESSAGING_SERVICE_SID SITE_URL PROJECT_REF)
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
JOB_NAME="send-reminders"
VAULT_NAME="send-reminders-service-key"
SCHEDULE="0 * * * *"

if [[ $DRY_RUN -eq 0 && "$CONFIRM" != "1" ]]; then
  echo "Refusing to deploy to $PROJECT_REF without CONFIRM_PROD=1 (or use --dry-run)." >&2
  exit 1
fi

SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_KEY:-}}"
JWT_RE='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'

if [[ -z "$SERVICE_KEY" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set (needed for the cron job)." >&2
    exit 1
  fi
  SERVICE_KEY="<SUPABASE_SERVICE_ROLE_KEY>"
elif [[ ! "$SERVICE_KEY" =~ $JWT_RE ]]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not a JWT (expected three dot-separated base64url parts, eyJ...)." >&2
  echo "Use the legacy service_role key from Dashboard -> Settings -> API; sb_secret_ keys are not accepted by the function." >&2
  exit 1
fi

# Twilio: all or nothing.
TWILIO_SET=0
if [[ -n "${TWILIO_ACCOUNT_SID:-}${TWILIO_AUTH_TOKEN:-}${TWILIO_FROM:-}${TWILIO_MESSAGING_SERVICE_SID:-}" ]]; then
  if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" ||
        -z "${TWILIO_FROM:-}${TWILIO_MESSAGING_SERVICE_SID:-}" ]]; then
    echo "ERROR: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID." >&2
    exit 1
  fi
  TWILIO_SET=1
fi

SECRET_VALUES=("${TWILIO_AUTH_TOKEN:-}" "${TWILIO_ACCOUNT_SID:-}")
[[ "$SERVICE_KEY" != "<SUPABASE_SERVICE_ROLE_KEY>" ]] && SECRET_VALUES+=("$SERVICE_KEY")

redact() {
  local s="$1" v
  for v in "${SECRET_VALUES[@]}"; do
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
# The EXIT trap deletes it if the caller does not.
temp_file() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  printf '%s\n' "$1" > "$file"
  printf '%s' "$file"
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

# 2. Pending migrations, then the push
LIST_SHOWN=0
echo "+ supabase migration list --linked"
if [[ $DRY_RUN -eq 0 || $LINKED -eq 1 ]]; then
  supabase migration list --linked
  LIST_SHOWN=1
  echo "# pending: rows with a Local version and an empty Remote column"
else
  echo "# not linked yet: the list is shown in the real run, after linking"
fi
if [[ $DRY_RUN -eq 0 && ( "$CONFIRM" != "1" || $LIST_SHOWN -ne 1 ) ]]; then
  echo "ERROR: db push needs CONFIRM_PROD=1 and the migration list shown above." >&2
  exit 1
fi
step supabase db push --linked --yes

# 3. Function (JWT verification stays on; the function also requires the service role key)
step supabase functions deploy send-reminders --project-ref "$PROJECT_REF"

# 4. Secrets, through a mode-600 env file
SECRET_LINES=()
if [[ $TWILIO_SET -eq 1 ]]; then
  SECRET_LINES+=("TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID" "TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN")
  [[ -n "${TWILIO_FROM:-}" ]] && SECRET_LINES+=("TWILIO_FROM=$TWILIO_FROM")
  [[ -n "${TWILIO_MESSAGING_SERVICE_SID:-}" ]] && SECRET_LINES+=("TWILIO_MESSAGING_SERVICE_SID=$TWILIO_MESSAGING_SERVICE_SID")
else
  echo "# no TWILIO_* variables set: skipping Twilio secrets; the function runs dry"
fi
[[ -n "${SITE_URL:-}" ]] && SECRET_LINES+=("SITE_URL=$SITE_URL")
if [[ ${#SECRET_LINES[@]} -gt 0 ]]; then
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
fi

# 5. Service role key in Vault, then the hourly schedule
VAULT_SQL="do \$vault\$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = '$VAULT_NAME';
  if v_id is null then
    perform vault.create_secret('$SERVICE_KEY', '$VAULT_NAME', 'service_role key for the send-reminders cron job');
  else
    perform vault.update_secret(v_id, '$SERVICE_KEY');
  end if;
end
\$vault\$;"

CRON_SQL="select cron.schedule(
  '$JOB_NAME',
  '$SCHEDULE',
  \$cmd\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = '$VAULT_NAME')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  \$cmd\$
);"

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

query_file "$VAULT_SQL"
query_file "$CRON_SQL"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# dry run: nothing was executed"
else
  echo "# done. Check runs with: supabase db query --linked \"select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = '$JOB_NAME') order by start_time desc limit 5;\""
fi
