// tools/deploy-barber-app.sh --dry-run on a checkout already linked to the
// project, before 0022 is there. The script runs from a copy in a temp
// directory (so this checkout's supabase/.temp and tools/.env.local are never
// read or written), with a fake project ref and a fake `supabase` first on
// PATH that logs every call and answers like production before the push:
// the privilege check fails with "function ... does not exist". Nothing is
// contacted: the dry run's manager login only prints its requests.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'fakefakefakefakefake';

const FAKE_SUPABASE = `#!/bin/sh
echo "$*" >> "$SUPABASE_CALLS"
case "$*" in
  "db query"*)
    echo 'ERROR: function public.notify_event_payload(bigint) does not exist (SQLSTATE 42883)' >&2
    exit 1 ;;
  "migration list"*)
    echo '   Local | Remote | Time'
    echo '   0022  |        | 0022' ;;
  "secrets list"*)
    echo 'APNS_KEY_ID | APNS_TEAM_ID | APNS_PRIVATE_KEY' ;;
  *)
    echo "fake supabase: unexpected call: $*" >&2
    exit 1 ;;
esac
`;

let dir, result, calls;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fe-deploy-'));
  mkdirSync(join(dir, 'tools'));
  mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const file of ['deploy-barber-app.sh', 'service-role-check.sql']) {
    copyFileSync(join(REPO, 'tools', file), join(dir, 'tools', file));
  }
  chmodSync(join(dir, 'tools', 'deploy-barber-app.sh'), 0o755);
  writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), REF);
  writeFileSync(join(dir, 'bin', 'supabase'), FAKE_SUPABASE);
  chmodSync(join(dir, 'bin', 'supabase'), 0o755);
  calls = join(dir, 'calls.log');

  result = spawnSync('bash', [join(dir, 'tools', 'deploy-barber-app.sh'), '--dry-run'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: dir,
      PROJECT_REF: REF,
      SUPABASE_CALLS: calls,
    },
  });
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('deploy-barber-app.sh --dry-run, linked, before 0022 is applied', () => {
  it('rehearses every step to the end and exits 0', () => {
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`# already linked to ${REF}`);
    expect(result.stdout).toContain('+ supabase db push --linked');
    expect(result.stdout).toContain(`+ supabase functions deploy staff-admin --project-ref ${REF}`);
    expect(result.stdout).toContain(`+ supabase functions deploy notify-booking-event --project-ref ${REF}`);
    expect(result.stdout).toContain('+ supabase db query --linked -f <tmpfile> <<SQL');   // Vault
    expect(result.stdout).toContain(`+ POST https://${REF}.supabase.co/auth/v1/admin/users`);
    expect(result.stdout).toContain('# Checklist (dashboard only');
    expect(result.stdout.trimEnd().endsWith('# dry run: nothing was executed')).toBe(true);
  });

  it('prints the privilege check as a step and does not run it against the project', () => {
    expect(result.stdout).toContain('+ supabase db query --linked -f tools/service-role-check.sql\n'
      + '# dry run: not run. The real run checks service_role\'s privileges after the push\n');
    const made = readFileSync(calls, 'utf8').trim().split('\n');
    expect(made).toEqual([
      'migration list --linked',
      `secrets list --project-ref ${REF}`,
    ]);
    expect(result.stdout + result.stderr).not.toMatch(/lacks a privilege|Grant it in a migration/);
  });
});
