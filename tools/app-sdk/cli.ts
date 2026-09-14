#!/usr/bin/env node
/**
 * MOS App SDK — the developer CLI (MKT-049, spec/effective-backlog-v1.5.md
 * "community developer workflow for scaffolding, local validation,
 * capability contracts, UI surfaces, manifests, tests, signing/publishing
 * and documentation").
 *
 * Usage:
 *   node tools/app-sdk/cli.ts scaffold <dir> --app-key <key>
 *        [--version <semver>] [--capability <name>]... [--surface <kind>]...
 *        [--description <text>]
 *   node tools/app-sdk/cli.ts validate <dir>
 *   node tools/app-sdk/cli.ts sign <dir>
 *   node tools/app-sdk/cli.ts docs [--out <file>]
 *   node tools/app-sdk/cli.ts publish <dir> --base-url <url> --token <token>
 *        --idempotency-key <key>
 *
 * The CLI is part of the SDK's OUTBOUND artifact: it imports ONLY the
 * SDK package + node builtins (never the MOS repository source —
 * enforced by tests/architecture/developer-portal-boundary.test.ts).
 * `validate` runs the OFFLINE mirror of the registry guard (drift-pinned
 * to the authority — tests/unit/app-sdk-drift.test.ts); `publish` is the
 * ONLINE command (the typed client over the Developer Portal routes).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { MosDeveloperPortalClient, MosApiError } from './src/client.ts';
import { generateDeveloperDocsMarkdown } from './src/docs.ts';
import { appManifestFingerprint, signManifest } from './src/fingerprint.ts';
import { scaffoldAppProject, scaffoldOptionProblems } from './src/scaffold.ts';
import type { AppUiSurfaceKindOption, ScaffoldOptions } from './src/scaffold.ts';
import { validateAppProjectFiles } from './src/validate.ts';
import { APP_PROJECT_FILES } from './src/validate.ts';

interface ParsedArgs {
  readonly command: string | null;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly repeated: Readonly<Record<string, readonly string[]>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const valueFlags = new Set([
    '--app-key',
    '--version',
    '--description',
    '--surface',
    '--capability',
    '--out',
    '--base-url',
    '--token',
    '--idempotency-key',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) {
        fail(`${arg} requires a value`);
      }
      if (arg === '--capability' || arg === '--surface') {
        (repeated[arg] ??= []).push(value);
        flags[arg] = true;
      } else {
        flags[arg] = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      flags[arg] = true;
      continue;
    }
    positional.push(arg);
  }
  return { command: positional[0] ?? null, positional, flags, repeated };
}

function fail(message: string): never {
  process.stderr.write(`mos-app-sdk: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function usage(): void {
  process.stdout.write(
    [
      'MOS App SDK CLI (MKT-049)',
      '',
      'Commands:',
      '  scaffold <dir> --app-key <key> [--version <semver>] [--capability <name>]... [--surface <kind>]... [--description <text>]',
      '                           scaffold a new App project (manifest + capability contracts + UI surfaces + tests + README)',
      '  validate <dir>           validate an App project offline (manifest conformance, capability contracts, UI surfaces, test presence, signature)',
      '  sign <dir>               write signature.json (the manifest-sha256-fingerprint hash attestation)',
      '  docs [--out <file>]      print (or write) the developer documentation generated from the frozen contracts',
      '  publish <dir> --base-url <url> --token <token> --idempotency-key <key>',
      '                           publish through the Developer Portal (online; platform_developer token)',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

function collectProjectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(current, entry.name);
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        files[rel] = readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir, '');
  return files;
}

function runScaffold(args: ParsedArgs): void {
  const dir = args.positional[1];
  if (dir === undefined) fail('scaffold requires a target directory');
  const appKey = args.flags['--app-key'];
  if (typeof appKey !== 'string' || appKey.length === 0) {
    fail('scaffold requires --app-key <key> (2-63 chars, lowercase letters/digits/dashes)');
  }
  const options: ScaffoldOptions = {
    appKey,
    ...(typeof args.flags['--version'] === 'string' ? { version: args.flags['--version'] } : {}),
    ...(args.repeated['--capability'] !== undefined
      ? { capabilities: args.repeated['--capability'] }
      : {}),
    ...(args.repeated['--surface'] !== undefined
      ? { surfaces: args.repeated['--surface'] as readonly AppUiSurfaceKindOption[] }
      : {}),
    ...(typeof args.flags['--description'] === 'string'
      ? { description: args.flags['--description'] }
      : {}),
  };
  const optionProblems = scaffoldOptionProblems(options);
  if (optionProblems.length > 0) {
    for (const problem of optionProblems) process.stderr.write(`mos-app-sdk: ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  const result = scaffoldAppProject(options);
  for (const file of result.files) {
    const target = join(dir, file.path);
    if (!existsSync(dirname(target))) {
      mkdirSync(dirname(target), { recursive: true });
    }
    writeFileSync(target, file.content, 'utf8');
    process.stdout.write(`created ${file.path}\n`);
  }
  process.stdout.write(
    `\nNext: node tools/app-sdk/cli.ts validate ${dir}\n       node --test '${dir}/tests/*.test.ts'\n       node tools/app-sdk/cli.ts sign ${dir}\n`,
  );
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function runValidate(args: ParsedArgs): void {
  const dir = args.positional[1];
  if (dir === undefined) fail('validate requires a project directory');
  if (!existsSync(dir)) fail(`project directory not found: ${dir}`);
  const files = collectProjectFiles(dir);
  const result = validateAppProjectFiles(files);
  if (result.valid) {
    process.stdout.write(
      `OK — ${APP_PROJECT_FILES.manifest} conforms to the frozen manifest contract; capability contracts, UI-surface declarations and tests are consistent${files[APP_PROJECT_FILES.signature] !== undefined ? '; the signature attestation verifies' : ''}.\n`,
    );
    return;
  }
  process.stderr.write(`INVALID — ${result.problems.length} problem(s):\n`);
  for (const problem of result.problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

function runSign(args: ParsedArgs): void {
  const dir = args.positional[1];
  if (dir === undefined) fail('sign requires a project directory');
  const manifestPath = join(dir, APP_PROJECT_FILES.manifest);
  if (!existsSync(manifestPath)) {
    fail(`${APP_PROJECT_FILES.manifest} not found in ${dir}`);
  }
  const manifestText = readFileSync(manifestPath, 'utf8');
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch (error) {
    fail(`${APP_PROJECT_FILES.manifest} is not valid JSON (${String(error)})`);
  }
  const signature = signManifest(manifest);
  writeFileSync(
    join(dir, APP_PROJECT_FILES.signature),
    `${JSON.stringify(signature, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `signed — ${APP_PROJECT_FILES.signature} written (algorithm ${signature.algorithm}, digest ${signature.digest})\n` +
      `publish it as the optional publish-envelope signature; the registry verifies it against the manifest's canonical fingerprint (${appManifestFingerprint(manifest)}).\n`,
  );
}

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

function runDocs(args: ParsedArgs): void {
  const markdown = generateDeveloperDocsMarkdown();
  const out = args.flags['--out'];
  if (typeof out === 'string') {
    if (!existsSync(dirname(out))) {
      mkdirSync(dirname(out), { recursive: true });
    }
    writeFileSync(out, markdown, 'utf8');
    process.stdout.write(`developer documentation written to ${out}\n`);
    return;
  }
  process.stdout.write(markdown);
}

// ---------------------------------------------------------------------------
// publish (online — the typed client over the Developer Portal routes)
// ---------------------------------------------------------------------------

function runPublish(args: ParsedArgs): void {
  const dir = args.positional[1];
  if (dir === undefined) fail('publish requires a project directory');
  const baseUrl = args.flags['--base-url'];
  const token = args.flags['--token'];
  const idempotencyKey = args.flags['--idempotency-key'];
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) fail('publish requires --base-url <url>');
  if (typeof token !== 'string' || token.length === 0) fail('publish requires --token <token>');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    fail('publish requires --idempotency-key <key>');
  }
  const manifestPath = join(dir, APP_PROJECT_FILES.manifest);
  if (!existsSync(manifestPath)) fail(`${APP_PROJECT_FILES.manifest} not found in ${dir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const signaturePath = join(dir, APP_PROJECT_FILES.signature);
  const signature = existsSync(signaturePath)
    ? (JSON.parse(readFileSync(signaturePath, 'utf8')) as unknown)
    : null;

  const client = new MosDeveloperPortalClient({ baseUrl, token });
  client
    .publishAppVersion(manifest as never, idempotencyKey, signature as never)
    .then((result) => {
      process.stdout.write(
        `published ${result.appVersion.appKey}@${result.appVersion.manifest.version} (appVersionId ${result.appVersion.appVersionId}, certification ${result.appVersion.certificationState})\n` +
          (result.signature === null
            ? 'unsigned publish (no signature.json found — run: node tools/app-sdk/cli.ts sign <dir>)\n'
            : `signature verified (algorithm ${result.signature.algorithm}, digest ${result.signature.digest})\n`),
      );
    })
    .catch((error: unknown) => {
      if (error instanceof MosApiError) {
        process.stderr.write(
          `publish failed: HTTP ${error.status} ${error.code ?? ''} ${error.message}\n` +
            (error.details.length > 0
              ? `${error.details.map((detail) => `  - ${detail}`).join('\n')}\n`
              : ''),
        );
      } else {
        process.stderr.write(`publish failed: ${String(error)}\n`);
      }
      process.exitCode = 1;
    });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case 'scaffold':
    runScaffold(args);
    break;
  case 'validate':
    runValidate(args);
    break;
  case 'sign':
    runSign(args);
    break;
  case 'docs':
    runDocs(args);
    break;
  case 'publish':
    runPublish(args);
    break;
  case null:
  case 'help':
  case '--help':
    usage();
    break;
  default:
    usage();
    fail(`unknown command '${args.command}'`);
}
