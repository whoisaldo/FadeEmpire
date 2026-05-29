#!/usr/bin/env bash
#
# export-appointments.sh — LOCAL developer view of all upcoming appointments.
#
# Reads the full bookings table (incl. customer name + phone) from Supabase and
# writes a day-grouped, human-readable file you can review day to day.
#
# Customer PII is RLS-locked, so this needs the Supabase *service_role* key.
# That key bypasses all security — keep it LOCAL. Never commit it, never deploy it.
#
# Usage:
#   1. Put your service_role key in tools/.env.local (gitignored):
#        SUPABASE_SERVICE_KEY=eyJ...your service_role key...
#      (Supabase Dashboard -> Settings -> API -> Project API keys -> service_role)
#   2. Run:
#        ./tools/export-appointments.sh
#   Output: tools/appointments.local.txt  (gitignored)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.local"
OUT_FILE="$SCRIPT_DIR/appointments.local.txt"

SUPABASE_URL="https://mjehfaonibgobimfiijk.supabase.co"

# Load local env file if present (does not override an already-set env var).
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

if [[ -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
  echo "ERROR: SUPABASE_SERVICE_KEY is not set." >&2
  echo "Add it to $ENV_FILE or export it before running. See the header of this script." >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required (brew install jq)." >&2; exit 1; }

# Pull active (pending + confirmed) bookings from today onward, ordered for reading.
TODAY="$(date +%F)"
RESP="$(curl -fsS \
  "$SUPABASE_URL/rest/v1/bookings?select=booking_date,booking_time,status,customer_name,customer_phone,service_id,total_price_cents,selected_addons,customer_notes,custom_request,id&status=in.(pending,confirmed)&booking_date=gte.$TODAY&order=booking_date.asc,booking_time.asc" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY")" || {
    echo "ERROR: request to Supabase failed. Check your service_role key." >&2
    exit 1
  }

# Map service_id -> display_name for readable output.
SERVICES="$(curl -fsS \
  "$SUPABASE_URL/rest/v1/services?select=id,display_name" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY")" || SERVICES="[]"

GENERATED_AT="$(date '+%Y-%m-%d %H:%M %Z')"

printf '%s' "$RESP" | jq -r --argjson services "$SERVICES" --arg gen "$GENERATED_AT" '
  ($services | map({key: .id, value: .display_name}) | from_entries) as $svc
  | (
      "FADE EMPIRE — APPOINTMENTS (local dev view)",
      "Generated: \($gen)",
      "Total upcoming: \(length)",
      "============================================================",
      ""
    ),
    (
      group_by(.booking_date)[]
      | "── \(.[0].booking_date) ─────────────────────────────",
        (
          sort_by(.booking_time)[]
          | "  \(.booking_time[0:5])  \(.customer_name)  ·  \(.customer_phone)",
            "          \($svc[.service_id] // "service?")  ·  $\(.total_price_cents / 100)  ·  \(.status)" +
              ( if (.selected_addons | length) > 0 then "  ·  add-ons: \(.selected_addons | join(", "))" else "" end ),
            ( if (.custom_request // "") != "" then "          custom: \(.custom_request)" else empty end ),
            ( if (.customer_notes // "") != "" then "          notes: \(.customer_notes)" else empty end ),
            "          ref: \(.id[0:8])"
        ),
        ""
    )
' > "$OUT_FILE"

COUNT="$(printf '%s' "$RESP" | jq 'length')"
echo "Wrote $COUNT upcoming appointment(s) to $OUT_FILE"
