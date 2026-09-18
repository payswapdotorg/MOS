/**
 * E2E harness evidence recorder (VER-001).
 *
 * Every journey writes redacted JSON + screenshots into
 *   tests/e2e/evidence/<run-id>/<journey>/
 * REDACTION (two layers): any JSON key matching
 * /token|password|secret|authorization|credential|bearer/i is replaced with
 * "[REDACTED]" recursively before anything is written, AND the exact
 * throwaway-identity values (email + password) are replaced wherever they
 * appear in serialized text (the account menu renders the signed-in email).
 * Request headers are never recorded. Throwaway credentials therefore never
 * land in committed files (they live in the operator worklog only).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_ROOT = path.join(E2E_ROOT, 'evidence');

const SENSITIVE_KEY_PATTERN = /token|password|secret|authorization|credential|bearer/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(inner);
    }
    return out;
  }
  return value;
}

/** Replace exact sensitive VALUES (the throwaway identity) in serialized text. */
function redactValuesInText(text, values) {
  let out = text;
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) {
      out = out.split(value).join('[REDACTED]');
    }
  }
  return out;
}

export function evidenceFor(runId, journeyName, sensitiveValues = []) {
  const dir = path.join(EVIDENCE_ROOT, runId, journeyName);
  fs.mkdirSync(dir, { recursive: true });

  const values = sensitiveValues.filter(
    (value) => typeof value === 'string' && value.length >= 4,
  );
  const serialize = (payload) => redactValuesInText(JSON.stringify(payload, null, 2), values);

  const used = new Set();
  const uniqueName = (name) => {
    let candidate = name;
    let i = 1;
    while (used.has(candidate)) {
      candidate = `${name}-${++i}`;
    }
    used.add(candidate);
    return candidate;
  };

  return {
    dir,
    /** Record an API response (status + redacted body) as JSON evidence. */
    response(name, result, note) {
      const file = path.join(dir, `${uniqueName(name)}.json`);
      const payload = {
        recordedAt: new Date().toISOString(),
        note: note ?? null,
        request: { method: result.method, url: result.url },
        status: result.status,
        body: redact(result.body),
      };
      fs.writeFileSync(file, `${serialize(payload)}\n`);
      return path.relative(E2E_ROOT, file);
    },
    /** Record an arbitrary redacted JSON artifact. */
    json(name, data, note) {
      const file = path.join(dir, `${uniqueName(name)}.json`);
      fs.writeFileSync(
        file,
        `${serialize({ recordedAt: new Date().toISOString(), note: note ?? null, data: redact(data) })}\n`,
      );
      return path.relative(E2E_ROOT, file);
    },
    /** Record a text artifact (logs, browser console output…). */
    text(name, text) {
      const file = path.join(dir, `${uniqueName(name)}.txt`);
      const safe = redactValuesInText(String(text), values);
      fs.writeFileSync(file, safe.endsWith('\n') ? safe : `${safe}\n`);
      return path.relative(E2E_ROOT, file);
    },
    /** Screenshot via the browser wrapper (path must be absolute). */
    screenshotPath(name) {
      return path.join(dir, `${uniqueName(name)}.png`);
    },
  };
}
