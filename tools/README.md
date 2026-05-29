# Tools (local only)

Developer utilities that are **not** part of the deployed site. Nothing here should
ever be committed with secrets or customer data — `.gitignore` is set up to keep the
service key and the exported appointments file out of git.

## export-appointments.sh — daily appointments view

Writes a readable, day-grouped list of all upcoming appointments (with customer name +
phone) to `appointments.local.txt` so you can review who's booked, day to day.

### Why it needs a special key

Customer data in the `bookings` table is locked behind Row-Level Security — the public
site key (anon/publishable) can only read PII-free availability. To read names and
phones you need the **service_role** key, which bypasses RLS. **It is a secret. Keep it
on your machine only.**

### One-time setup

1. Get the key: Supabase Dashboard → your project → **Settings → API** →
   **Project API keys** → copy the **`service_role`** key.
2. Create `tools/.env.local` (this file is gitignored) with:

   ```
   SUPABASE_SERVICE_KEY=eyJ...paste the service_role key here...
   ```

### Run it

```bash
./tools/export-appointments.sh
```

Output: `tools/appointments.local.txt`. Re-run any time to refresh.

You can also pass the key inline without a file:

```bash
SUPABASE_SERVICE_KEY=eyJ... ./tools/export-appointments.sh
```

### What's safe / not safe

- `tools/.env.local` — your secret key. **Local only.** Gitignored.
- `tools/appointments.local.txt` — contains customer PII. **Local only.** Gitignored.
- Never paste the service_role key into front-end code (`scripts/config.js`) — that file
  ships to the public site. The site only ever uses the publishable key.
