// tools/deploy-barber-app.sh on a checkout already linked to the project,
// before 0022 is there. The script runs from a copy in a temp directory (so
// this checkout's supabase/.temp and tools/.env.local are never read or
// written), with a fake project ref and a fake `supabase` first on PATH that
// logs every call and answers like production before the push: the privilege
// check fails with "function ... does not exist", and `migration list` prints
// whatever history the test gives it. Nothing is contacted: the dry run's
// manager login only prints its requests, and a real run stops at the fake
// `db push`.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, openSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'fakefakefakefakefake';
const MIGRATIONS = readdirSync(join(REPO, 'supabase', 'migrations')).filter(f => /^\d+_.*\.sql$/.test(f));
const VERSIONS = MIGRATIONS.map(f => f.split('_')[0]).sort();

const FAKE_SUPABASE = `#!/bin/sh
echo "$*" >> "$SUPABASE_CALLS"
case "$*" in
  "db query"*)
    echo 'ERROR: function public.notify_event_payload(bigint) does not exist (SQLSTATE 42883)' >&2
    exit 1 ;;
  "migration list"*)
    cat "$MIGRATION_LIST"
    exit "\${MIGRATION_LIST_EXIT:-0}" ;;
  "secrets list"*)
    echo 'APNS_KEY_ID | APNS_TEAM_ID | APNS_PRIVATE_KEY' ;;
  "db push"*)
    echo 'fake supabase: db push reached' >&2
    exit 1 ;;
  *)
    echo "fake supabase: unexpected call: $*" >&2
    exit 1 ;;
esac
`;

// The CLI's two forms of `migration list` (2.109.0): JSON when asked for it
// (or run by an agent), the table in a terminal. `pending` are the local
// versions production's history lacks; `extraRemote` are versions it has
// with no file here.
const history = (pending, extraRemote = []) => [
  ...VERSIONS.map(v => ({ local: v, remote: pending.includes(v) ? '' : v, time: v })),
  ...extraRemote.map(v => ({ local: '', remote: v, time: v })),
];
const asJson = (rows) => JSON.stringify({ migrations: rows, message: 'Migrations listed' }) + '\n';
const asTable = (rows) => '\n  \n   Local  | Remote | Time (UTC) \n  --------|--------|------------\n'
  + rows.map(r => `   \`${r.local || ' '}\` | \`${r.remote || ' '}\` | \`${r.time}\`     `).join('\n') + '\n\n';

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Runs the script (--dry-run unless real) and returns its result and the CLI calls it made.
// A real run gets a terminal on stdin (all the script checks), CONFIRM_PROD=1 and
// stand-in credentials.
function deploy({ list, listExit = 0, real = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'fe-deploy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools'));
  mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
  mkdirSync(join(dir, 'supabase', 'migrations'));
  mkdirSync(join(dir, 'bin'));
  for (const file of ['deploy-barber-app.sh', 'service-role-check.sql']) {
    copyFileSync(join(REPO, 'tools', file), join(dir, 'tools', file));
  }
  for (const file of MIGRATIONS) {
    copyFileSync(join(REPO, 'supabase', 'migrations', file), join(dir, 'supabase', 'migrations', file));
  }
  chmodSync(join(dir, 'tools', 'deploy-barber-app.sh'), 0o755);
  writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), REF);
  writeFileSync(join(dir, 'bin', 'supabase'), FAKE_SUPABASE);
  chmodSync(join(dir, 'bin', 'supabase'), 0o755);
  writeFileSync(join(dir, 'list.out'), list);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');

  const script = join(dir, 'tools', 'deploy-barber-app.sh');
  const [cmd, args] = real
    ? ['python3', ['-c', 'import os, subprocess, sys; m, s = os.openpty(); '
      + 'sys.exit(subprocess.run(sys.argv[1:], stdin=s).returncode)', 'bash', script]]
    : ['bash', [script, '--dry-run']];
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: [openSync('/dev/null', 'r'), 'pipe', 'pipe'],
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: dir,
      PROJECT_REF: REF,
      SUPABASE_CALLS: calls,
      MIGRATION_LIST: join(dir, 'list.out'),
      MIGRATION_LIST_EXIT: String(listExit),
      ...(real ? { CONFIRM_PROD: '1', SUPABASE_SERVICE_ROLE_KEY: 'aaaa.bbbb.cccc', MANAGER_EMAIL: 'ali@example.com' } : {}),
    },
  });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

const REFUSED = 'Nothing was pushed.';

describe('deploy-barber-app.sh --dry-run, linked, before 0022 is applied', () => {
  const result = deploy({ list: asTable(history(['0022'])) });

  it('rehearses every step to the end and exits 0', () => {
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`# already linked to ${REF}`);
    expect(result.stdout).toContain('# pending migrations: 0022 (only 0021 and 0022 may be)');
    expect(result.stdout).toContain('+ supabase db push --linked');
    expect(result.stdout).toContain(`+ supabase functions deploy staff-admin --project-ref ${REF}`);
    expect(result.stdout).toContain(`+ supabase functions deploy notify-booking-event --project-ref ${REF}`);
    expect(result.stdout).toContain('+ supabase db query --linked -f <tmpfile> <<SQL');   // Vault
    expect(result.stdout).toContain(`+ POST https://${REF}.supabase.co/auth/v1/admin/users`);
    expect(result.stdout).toContain('# Rollout, in this order');
    expect(result.stdout.trimEnd().endsWith('# dry run: nothing was executed')).toBe(true);
  });

  it('prints the privilege check as a step and does not run it against the project', () => {
    expect(result.stdout).toContain('+ supabase db query --linked -f tools/service-role-check.sql\n'
      + '# dry run: not run. The real run checks service_role\'s privileges after the push\n');
    expect(result.calls).toEqual([
      'migration list --linked --output-format=json',
      `secrets list --project-ref ${REF}`,
    ]);
    expect(result.stdout + result.stderr).not.toMatch(/lacks a privilege|Grant it in a migration/);
  });
});

describe('the pending-migration guard', () => {
  it('lets 0021 and 0022 through (0021 is safe to run again)', () => {
    const r = deploy({ list: asJson(history(['0021', '0022'])) });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# pending migrations: 0021 0022');
    expect(r.stdout).toContain('+ supabase db push --linked');
  });

  it('lets a run with nothing pending through (running it again for the APNs secrets)', () => {
    const r = deploy({ list: asJson(history([])) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# pending migrations: none');
  });

  it('refuses when production\'s history has none of the migrations applied by hand', () => {
    const r = deploy({ list: asJson(history(VERSIONS)) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`ERROR: a push would run ${VERSIONS.join(' ')}; only 0021 and 0022 may run.`);
    expect(r.stderr).toContain('0001_init.sql');
    expect(r.stderr).toContain('every booking would be lost');
    expect(r.stderr).toContain(`supabase migration repair --linked --status applied ${VERSIONS.filter(v => v < '0021').join(' ')}\n`);
    expect(r.stderr).toContain(REFUSED);
    expect(r.stdout).not.toContain('db push');
    expect(r.calls).toEqual(['migration list --linked --output-format=json']);
  });

  it('refuses when one old migration is missing from the history (table form)', () => {
    const r = deploy({ list: asTable(history(['0020', '0022'])) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR: a push would run 0020 0022; only 0021 and 0022 may run.');
    expect(r.stderr).toContain('supabase migration repair --linked --status applied 0020\n');
    expect(r.stdout).not.toContain('db push');
  });

  it('refuses when production has a migration this checkout does not', () => {
    const r = deploy({ list: asJson(history(['0022'], ['0023'])) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the project has migrations with no file here: 0023');
    expect(r.stdout).not.toContain('db push');
  });

  it.each([
    ['output it cannot read', { list: 'Connecting to remote database...\nsomething else\n' }],
    ['a table without a row for every migration file', { list: asTable(history(['0022']).filter(r => r.local !== '0005')) }],
    ['JSON of another shape', { list: '{"message":"Migrations listed"}\n' }],
    ['a failing command', { list: '', listExit: 1 }],
  ])('refuses on %s', (_, opts) => {
    const r = deploy(opts);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR: could not read the project\'s migration history, so it is not safe to push.');
    expect(r.stderr).toContain(REFUSED);
    expect(r.stdout).not.toContain('db push');
    expect(r.calls.every(c => c.startsWith('migration list --linked'))).toBe(true);
  });

  it('falls back to the plain list when the JSON one fails, and still refuses', () => {
    const r = deploy({ list: '', listExit: 1 });
    expect(r.calls).toEqual(['migration list --linked --output-format=json', 'migration list --linked']);
  });

  describe('in a real run (a terminal, CONFIRM_PROD=1)', () => {
    it('stops before the push when old migrations are pending', () => {
      const r = deploy({ list: asJson(history(VERSIONS)), real: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('every booking would be lost');
      expect(r.calls).toEqual(['migration list --linked --output-format=json']);
    });

    it('stops before the push when the history cannot be read', () => {
      const r = deploy({ list: 'garbage\n', real: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not read the project\'s migration history');
      expect(r.calls).not.toContain('db push --linked');
    });

    it('goes on to the push when only 0022 is pending', () => {
      const r = deploy({ list: asTable(history(['0022'])), real: true });
      expect(r.calls).toEqual(['migration list --linked --output-format=json', 'db push --linked']);
      expect(r.stderr).toContain('fake supabase: db push reached');
    });
  });
});
