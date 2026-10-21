#!/usr/bin/env bash
#
# booking-lock-check.sh — two-session checks of tg_booking_no_overlap's lock (0022)
# against the LOCAL stack (tools/local-stack.sh). pgTAP runs in one session, so it
# cannot show a lock wait or a deadlock; this runs two psql sessions at once.
#
#   1. Opposite-order batches: A books Hassan 10:00 then Larry 10:00, B books Larry
#      11:30 then Hassan 11:30, interleaved. Nothing overlaps, so both must finish.
#      With one lock per chair and day this deadlocks; with the shop-wide lock B
#      waits for A. Both roll back, so nothing stays.
#   2. Two overlapping inserts at once on one chair (13:00 and 13:15): exactly one
#      gets slot_taken. B starts while A holds the lock and checks after A commits.
#      The rows are continuations of cancelled primaries, which write no
#      booking_events (so no activity and no push), and are deleted at the end.
#
# Direct inserts as the table owner, the path owner tooling takes; every RPC inserts
# through the same trigger. The day is current_date + 57; the check stops if either
# chair has an active booking that day.
#
# Usage: tools/booking-lock-check.sh      exit 0 when both checks pass

set -euo pipefail

export DOCKER_HOST="unix://$HOME/.colima/fadeempire/docker.sock"
DB="supabase_db_fadeempire-app"
TMP="$(mktemp -d)"

q() { docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -q -At -U postgres -d postgres "$@"; }

cleanup() {
  q -c "delete from bookings where customer_phone like '555999000%'" >/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# psql input that inserts one confirmed booking at :'t' on :'chair'.
insert_sql() {
  cat <<'SQL'
insert into bookings (barber_id, service_id, booking_date, booking_time, customer_name,
                      customer_phone, total_price_cents, status, hold_expires_at, linked_to)
values ((select id from barbers where slug = :'chair'), (select id from services where slug = 'hair-cut'),
        current_date + 57, :'t'::time, 'Lock Check', :'phone', 0, 'confirmed', null,
        nullif(:'link', '')::uuid);
SQL
}

# session NAME END STEP... ; each STEP is "chair time phone [link]" or "sleep N", run in one
# transaction that ends with $END (commit or rollback).
session() {
  local name="$1" end="$2" rc=0; shift 2
  {
    echo '\set ON_ERROR_STOP 1'
    echo 'begin;'
    for step in "$@"; do
      set -- $step
      if [[ "$1" == sleep ]]; then
        echo "select pg_sleep($2);"
      else
        echo "\\set chair $1"
        echo "\\set t $2"
        echo "\\set phone $3"
        echo "\\set link '${4:-}'"
        insert_sql
        echo "select '$name booked $1 $2 at ' || clock_timestamp()::time(0);"
      fi
    done
    echo "$end;"
  } | docker exec -i "$DB" psql -X -q -At -U postgres -d postgres >"$TMP/$name.out" 2>&1 || rc=$?
  echo "$rc" >"$TMP/$name.rc"
}

busy="$(q -c "select count(*) from bookings bk join barbers b on b.id = bk.barber_id
               where b.slug in ('hassan', 'larry') and bk.booking_date = current_date + 57
                 and bk.status in ('pending', 'confirmed', 'completed')")"
if [[ "$busy" != "0" ]]; then
  echo "current_date + 57 already has $busy active bookings on hassan/larry; pick another day" >&2
  exit 2
fi

fail=0

echo "== 1. Opposite-order batches on two chairs (nothing overlaps)"
session A rollback "hassan 10:00 5559990001" "sleep 2" "larry 10:00 5559990002" &
sleep 1
session B rollback "larry 11:30 5559990003" "sleep 2" "hassan 11:30 5559990004" &
wait
for s in A B; do
  echo "-- session $s (exit $(cat "$TMP/$s.rc"))"
  grep -v '^ROLLBACK$\|^BEGIN$\|^$' "$TMP/$s.out" | sed 's/^/   /'
done
if grep -qi 'deadlock\|error' "$TMP/A.out" "$TMP/B.out"; then
  echo "FAIL: a batch failed"; fail=1
else
  echo "PASS: both batches finished"
fi

echo
echo "== 2. Two overlapping inserts at once on one chair (13:00, 13:15)"
q <<'SQL'
insert into bookings (id, barber_id, service_id, booking_date, booking_time, customer_name,
                      customer_phone, total_price_cents, status, hold_expires_at)
select v.id, b.id, s.id, current_date + 57, v.t, 'Lock Check', v.phone, 0, 'cancelled', null
  from (values ('00000000-0000-4000-b000-000000000001'::uuid, time '09:00', '5559990005'),
               ('00000000-0000-4000-b000-000000000002'::uuid, time '09:15', '5559990006')) v(id, t, phone),
       barbers b, services s
 where b.slug = 'hassan' and s.slug = 'hair-cut';
SQL
session C commit "hassan 13:00 5559990007 00000000-0000-4000-b000-000000000001" "sleep 2" &
sleep 1
session D commit "hassan 13:15 5559990008 00000000-0000-4000-b000-000000000002" &
wait
for s in C D; do
  echo "-- session $s (exit $(cat "$TMP/$s.rc"))"
  grep -v '^COMMIT$\|^BEGIN$\|^ROLLBACK$\|^$' "$TMP/$s.out" | sed 's/^/   /'
done
taken="$(cat "$TMP/C.out" "$TMP/D.out" | grep -c 'slot_taken' || true)"
active="$(q -c "select count(*) from bookings where customer_phone in ('5559990007', '5559990008')
                 and status = 'confirmed'")"
echo "slot_taken errors: $taken, rows booked: $active"
if [[ "$taken" == "1" && "$active" == "1" ]]; then
  echo "PASS: exactly one slot_taken"
else
  echo "FAIL: expected one slot_taken and one row"; fail=1
fi

exit "$fail"
