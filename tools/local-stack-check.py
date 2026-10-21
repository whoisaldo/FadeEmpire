"""local-stack-check.py — staff-admin's login flow end to end on the LOCAL stack, run by
`tools/local-stack.sh check` (which makes the throwaway barber and removes it and the
login afterwards). It calls everything the way the app does: Auth through Kong, the
function through Kong and the edge runtime, the RPCs through PostgREST.

The manager creates a barber login; the barber signs in with the temporary password
(must change it), chooses a password; the manager resets it, disables the login (no
sign-in, and the barber's still-valid JWT sees nothing) and enables it again.

Environment: API (http://127.0.0.1:56321), ANON (the anon key), BARBER (the barber's
id), EMAIL (the new login). Prints one line per check; exits 1 at the first failure.
"""

import json
import os
import sys
import urllib.error
import urllib.request

API, ANON, BARBER, EMAIL = (os.environ[k] for k in ("API", "ANON", "BARBER", "EMAIL"))
MANAGER = ("ali@local.test", "fade-local-1")
CHOSEN = "login-check-chosen-1"


def call(method, path, token=None, body=None):
    headers = {"apikey": ANON, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, raw.decode(errors="replace")


def expect(label, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else f": {detail}"), flush=True)
    if not ok:
        sys.exit(1)


def sign_in(email, password):
    status, body = call("POST", "/auth/v1/token?grant_type=password", body={"email": email, "password": password})
    return status, body.get("access_token") if isinstance(body, dict) else None


def admin(token, body):
    status, answer = call("POST", "/functions/v1/staff-admin", token, body)
    return status, answer if isinstance(answer, dict) else {"raw": answer}


def me(token):
    status, rows = call("POST", "/rest/v1/rpc/app_me", token, {})
    return status, rows if isinstance(rows, list) else []


status, ali = sign_in(*MANAGER)
expect("the manager signs in", status == 200 and ali, status)

status, body = admin(ali, {"action": "create_login", "email": EMAIL, "display_name": "Login Check",
                           "role": "barber", "barber_id": BARBER})
expect("create_login makes a barber login", status == 200 and body.get("temporary_password"), f"{status} {body}")
user_id, temporary = body["user_id"], body["temporary_password"]

status, token = sign_in(EMAIL, temporary)
expect("the barber signs in with the temporary password", status == 200 and token, status)
status, rows = me(token)
expect("app_me: their chair, must_change_password true",
       status == 200 and len(rows) == 1 and rows[0]["barber_id"] == BARBER and rows[0]["must_change_password"] is True,
       f"{status} {rows}")

status, body = call("PUT", "/auth/v1/user", token, {"password": CHOSEN})
expect("they choose a password (auth updateUser)", status == 200, f"{status} {body}")
status, body = call("POST", "/rest/v1/rpc/app_password_changed", token, {})
expect("app_password_changed", status in (200, 204), f"{status} {body}")
status, rows = me(token)
expect("must_change_password is cleared", len(rows) == 1 and rows[0]["must_change_password"] is False, rows)
status, token = sign_in(EMAIL, CHOSEN)
expect("they sign in with their own password", status == 200 and token, status)

status, body = admin(ali, {"action": "reset_password", "user_id": user_id})
expect("reset_password gives a new temporary password", status == 200 and body.get("temporary_password"),
       f"{status} {body}")
temporary = body["temporary_password"]
expect("their own password stops working", sign_in(EMAIL, CHOSEN)[0] == 400)
status, token = sign_in(EMAIL, temporary)
expect("the new temporary password works", status == 200 and token, status)
status, rows = me(token)
expect("must_change_password is set again", len(rows) == 1 and rows[0]["must_change_password"] is True, rows)

status, body = admin(ali, {"action": "disable_login", "user_id": user_id})
expect("disable_login", status == 200 and body == {"ok": True}, f"{status} {body}")
expect("a disabled login cannot sign in", sign_in(EMAIL, temporary)[0] == 400)
status, rows = me(token)
expect("its still-valid JWT gets no app_me row", status == 200 and rows == [], f"{status} {rows}")
status, body = call("POST", "/rest/v1/rpc/app_bookings", token,
                    {"p_barber_id": BARBER, "p_from": "2026-01-01", "p_to": "2026-01-31"})
expect("nor its chair's bookings (forbidden)",
       status == 403 and isinstance(body, dict) and body.get("message") == "forbidden", f"{status} {body}")

status, body = admin(ali, {"action": "enable_login", "user_id": user_id})
expect("enable_login", status == 200 and body == {"ok": True}, f"{status} {body}")
status, token = sign_in(EMAIL, temporary)
expect("the login signs in again", status == 200 and token, status)
status, rows = me(token)
expect("and has its chair back", len(rows) == 1 and rows[0]["barber_id"] == BARBER, rows)
