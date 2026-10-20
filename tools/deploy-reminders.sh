#!/usr/bin/env bash
#
# deploy-reminders.sh — deploys SMS reminders to the hosted Supabase project.
#
# Usage:
#   tools/deploy-reminders.sh --dry-run          print every command, run nothing
#   CONFIRM_PROD=1 tools/deploy-reminders.sh     run them
#
# Steps (each one is safe to repeat):
#   1. supabase link        only if this checkout is not linked to PROJECT_REF
#   2. supabase db push     applies 0019_sms_reminders.sql (and anything else pending)
#   3. supabase functions deploy send-reminders
#   4. supabase secrets set TWILIO_* (+ SITE_URL). Skipped when no TWILIO_* variable
#      is set; the function then runs dry (logs messages, sends and marks nothing).
#   5. cron.schedule('send-reminders', hourly) calling the function through pg_net.
#      Re-running replaces the job of the same name.
#
# Environment:
#   SUPABASE_SERVICE_ROLE_KEY   required for step 5 (the legacy service_role JWT; the
#                               function only accepts this key). Falls back to
#                               SUPABASE_SERVICE_KEY from tools/.env.local.
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID
#   SITE_URL                    optional, defaults to https://chicopeefadeempire.com
#   PROJECT_REF                 optional, defaults to mjehfaonibgobimfiijk
#
# Turn it off:
#   supabase db query --linked "select cron.unschedule('send-reminders');"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env.local"

PROJECT_REF="${PROJECT_REF:-mjehfaonibgobimfiijk}"
JOB_NAME="send-reminders"
SCHEDULE="0 * * * *"

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

if [[ $DRY_RUN -eq 0 && "${CONFIRM_PROD:-}" != "1" ]]; then
  echo "Refusing to deploy to $PROJECT_REF without CONFIRM_PROD=1 (or use --dry-run)." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_KEY:-}}"

if [[ -z "$SERVICE_KEY" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set (needed for the cron job)." >&2
    exit 1
  fi
  SERVICE_KEY="<SUPABASE_SERVICE_ROLE_KEY>"
elif [[ ! "$SERVICE_KEY" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY has unexpected characters." >&2
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

cd "$REPO_DIR"

# 1. Link
if [[ "$(cat supabase/.temp/project-ref 2>/dev/null || true)" != "$PROJECT_REF" ]]; then
  step supabase link --project-ref "$PROJECT_REF"
else
  echo "# already linked to $PROJECT_REF"
fi

# 2. Migrations
step supabase db push --linked --yes

# 3. Function (JWT verification stays on; the function also requires the service role key)
step supabase functions deploy send-reminders --project-ref "$PROJECT_REF"

# 4. Secrets
if [[ $TWILIO_SET -eq 1 ]]; then
  SECRETS=("TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID" "TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN")
  [[ -n "${TWILIO_FROM:-}" ]] && SECRETS+=("TWILIO_FROM=$TWILIO_FROM")
  [[ -n "${TWILIO_MESSAGING_SERVICE_SID:-}" ]] && SECRETS+=("TWILIO_MESSAGING_SERVICE_SID=$TWILIO_MESSAGING_SERVICE_SID")
  [[ -n "${SITE_URL:-}" ]] && SECRETS+=("SITE_URL=$SITE_URL")
  step supabase secrets set --project-ref "$PROJECT_REF" "${SECRETS[@]}"
else
  echo "# no TWILIO_* variables set: skipping secrets; the function runs dry"
  [[ -n "${SITE_URL:-}" ]] && step supabase secrets set --project-ref "$PROJECT_REF" "SITE_URL=$SITE_URL"
fi

# 5. Hourly schedule
CRON_SQL="select cron.schedule(
  '$JOB_NAME',
  '$SCHEDULE',
  \$cmd\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer $SERVICE_KEY'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  \$cmd\$
);"

printf '+ supabase db query --linked <<SQL\n%s\nSQL\n' "$(redact "$CRON_SQL")"
if [[ $DRY_RUN -eq 0 ]]; then
  supabase db query --linked "$CRON_SQL"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# dry run: nothing was executed"
else
  echo "# done. Check runs with: supabase db query --linked \"select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = '$JOB_NAME') order by start_time desc limit 5;\""
fi
