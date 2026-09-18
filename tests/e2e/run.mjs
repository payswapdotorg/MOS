#!/usr/bin/env node
/**
 * VER-001 E2E harness orchestrator — MOS product console journeys.
 *
 * Usage (from the repository root):
 *   node tests/e2e/run.mjs                      # all journeys, in dependency order
 *   node tests/e2e/run.mjs --journey=owner      # one journey
 *   node tests/e2e/run.mjs --list               # journey inventory
 *   node tests/e2e/run.mjs --api-only           # shorthand for MOS_E2E_SKIP_UI=1
 *
 * Target selection: MOS_E2E_BASE_URL (default: production console).
 * Credentials: environment only — never committed (see tests/e2e/README.md).
 * Exit code: 0 only when every selected journey PASSES.
 *
 * Requirements: Node >= 18 (stdlib fetch) and the agent-browser CLI for UI
 * steps. Zero external-workspace dependencies: everything runs from this
 * repository tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnv, describeEnv } from './lib/env.mjs';
import { apiClient } from './lib/http.mjs';
import { evidenceFor, EVIDENCE_ROOT } from './lib/evidence.mjs';
import { redact } from './lib/evidence.mjs';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const JOURNEYS = [
  { module: './journeys/signup-journey.mjs', needs: [] },
  { module: './journeys/owner-journey.mjs', needs: ['owner'] },
  { module: './journeys/client-journey.mjs', needs: ['owner'] },
  { module: './journeys/human-agent-journey.mjs', needs: ['agent'] },
  { module: './journeys/app-lifecycle-journey.mjs', needs: [] },
  { module: './journeys/tenant-isolation-journey.mjs', needs: ['owner'] },
  { module: './journeys/responsive-check.mjs', needs: ['owner'] },
];

function parseArgs(argv) {
  const args = { journeys: [], list: false, apiOnly: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--list') args.list = true;
    else if (arg === '--api-only') args.apiOnly = true;
    else if (arg.startsWith('--journey=')) args.journeys.push(arg.slice('--journey='.length).split(','));
    else if (arg.startsWith('--throwaway-credentials-file=')) args.credentialsFile = arg.slice('--throwaway-credentials-file='.length);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node tests/e2e/run.mjs [--journey=name[,name…]] [--list] [--api-only] [--throwaway-credentials-file=/path/outside/repo]\n');
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

/** Value of --<flag>=<value> style args (also accepted as separate tokens). */
function optionalArg(argv, flag) {
  const prefix = `${flag}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === flag) return argv[argv.indexOf(arg) + 1] ?? undefined;
  }
  return undefined;
}

function banner(text) {
  process.stdout.write(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apiOnly) process.env.MOS_E2E_SKIP_UI = '1';

  const env = resolveEnv();
  const api = apiClient(env.baseUrl);
  const shared = { throwaway: { ...env.throwaway, signedUp: false } };

  // Optional operator export of the generated throwaway identity to a file
  // OUTSIDE the repository (default: off). The operator uses it to record the
  // credentials in the worklog; nothing inside the repo ever holds them.
  const credentialsFile = optionalArg(process.argv, '--throwaway-credentials-file');
  if (credentialsFile !== undefined && env.throwaway.generated) {
    fs.mkdirSync(path.dirname(path.resolve(credentialsFile)), { recursive: true });
    fs.writeFileSync(
      credentialsFile,
      `${JSON.stringify(
        {
          note: 'operator-only export (lives outside the repo; record in the worklog, never commit)',
          email: env.throwaway.email,
          password: env.throwaway.password,
          displayName: env.throwaway.displayName,
          agencyName: env.throwaway.agencyName,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  if (args.list) {
    process.stdout.write('journeys (run order):\n');
    for (const entry of JOURNEYS) {
      const mod = await import(entry.module);
      process.stdout.write(
        `  ${String(mod.name).padEnd(16)} checklist: ${mod.checklist.join('; ')}\n` +
          `                   requires: ${mod.requires.join('; ')}\n`,
      );
    }
    process.exit(0);
  }

  const selected = args.journeys.flat();
  const missingCredentials = [];
  for (const entry of JOURNEYS) {
    const mod = await import(entry.module);
    if (selected.length > 0 && !selected.includes(mod.name)) continue;
    for (const need of entry.needs) {
      if (env[need] === undefined && !missingCredentials.includes(need)) {
        missingCredentials.push(need);
      }
    }
  }
  if (missingCredentials.length > 0) {
    process.stderr.write(
      `missing credentials for selected journeys: ${missingCredentials.join(', ')}\n` +
        'set MOS_E2E_OWNER_EMAIL/PASSWORD (and MOS_E2E_AGENT_EMAIL/PASSWORD for the human-agent journey)\n',
    );
    process.exit(2);
  }

  banner(`MOS E2E run ${env.runId}`);
  process.stdout.write(`${JSON.stringify(describeEnv(env), null, 2)}\n`);

  const results = [];
  for (const entry of JOURNEYS) {
    const mod = await import(entry.module);
    if (selected.length > 0 && !selected.includes(mod.name)) continue;
    banner(`journey: ${mod.name} — ${mod.checklist.join('; ')}`);
    // Value-level redaction set: the throwaway identity must never appear in
    // a committed evidence artifact (key-based redaction stays on top).
    const evidence = evidenceFor(env.runId, mod.name, [
      env.throwaway.email,
      env.throwaway.password,
    ]);
    const ctx = { env, api, evidence, shared };
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await mod.run(ctx);
    } catch (caught) {
      // A journey that explodes before its own outcome() capture.
      result = {
        journey: mod.name,
        status: 'FAIL',
        failedStep: String(caught?.message ?? caught),
        passedSteps: 0,
        failedSteps: 1,
        steps: [{ name: 'journey crashed', expect: 'completed', actual: String(caught?.message ?? caught), pass: false, note: null, evidence: [] }],
      };
    }
    result.startedAt = startedAt;
    result.finishedAt = new Date().toISOString();
    results.push(result);
    for (const step of result.steps) {
      const mark = step.pass ? 'PASS' : 'FAIL';
      process.stdout.write(`  [${mark}] ${step.name} → ${String(step.actual)}\n`);
      if (step.note !== null && step.note !== undefined && String(step.note).length > 0) {
        process.stdout.write(`         note: ${String(step.note).slice(0, 300)}\n`);
      }
    }
    process.stdout.write(`  ⇒ ${mod.name}: ${result.status} (${result.passedSteps} passed / ${result.failedSteps} failed)\n`);
  }

  const summary = {
    runId: env.runId,
    baseUrl: env.baseUrl,
    target: env.baseUrl,
    startedAt: results[0]?.startedAt ?? null,
    finishedAt: new Date().toISOString(),
    skipUi: env.skipUi,
    allowDemoOfferConsumption: env.allowDemoOfferConsumption,
    journeys: results.map((result) => ({
      journey: result.journey,
      status: result.status,
      passedSteps: result.passedSteps,
      failedSteps: result.failedSteps,
      failedStep: result.failedStep,
    })),
  };
  const summaryPath = path.join(EVIDENCE_ROOT, env.runId, 'run-summary.json');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(redact(summary), null, 2)}\n`);

  banner('run summary');
  for (const journey of summary.journeys) {
    process.stdout.write(
      `  ${journey.status.padEnd(4)} ${journey.journey.padEnd(16)} ${journey.passedSteps} passed / ${journey.failedSteps} failed${journey.failedStep ? ` — ${journey.failedStep.slice(0, 140)}` : ''}\n`,
    );
  }
  process.stdout.write(`\n  evidence: tests/e2e/evidence/${env.runId}/\n`);
  process.stdout.write(`  summary:  ${path.relative(process.cwd(), summaryPath)}\n`);

  const failed = summary.journeys.filter((journey) => journey.status === 'FAIL');
  process.stdout.write(`\n  RESULT: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILURE(S)`}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`harness crashed: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
