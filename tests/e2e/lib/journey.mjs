/**
 * E2E journey runner primitives (VER-001).
 *
 * A journey is a plain async function run(ctx) returning steps. Each step is
 * recorded as { name, expect, actual, pass, note, evidence? } — the runner
 * aggregates PASS/FAIL per journey and writes run-summary.json.
 *
 * Steps fail LOUD: the first failing assertion throws (recorded as the failing
 * step) so journeys stay deterministic and short.
 */

export class StepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepError';
  }
}

export function journey(name, { description, checklist, requires = [] } = {}) {
  return { name, description, checklist, requires, run: null };
}

export function createRunner(name) {
  const steps = [];
  const state = {
    step(name_, expect, actual, pass, note) {
      steps.push({ name: name_, expect, actual, pass, note: note ?? null, evidence: [] });
      return steps[steps.length - 1];
    },
    async check(name, expect, fn) {
      const actual = await fn();
      const pass = actual === expect;
      steps.push({ name, expect, actual, pass, note: null, evidence: [] });
      if (!pass) {
        throw new StepError(`${name}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}`);
      }
      return actual;
    },
    async checkFn(name, expectText, fn) {
      let actual;
      let pass;
      let note = null;
      let evidenceFiles = [];
      let value;
      try {
        value = await fn();
        ({ actual, pass, note, evidence: evidenceFiles } = value);
        if (!Array.isArray(evidenceFiles)) evidenceFiles = [];
      } catch (error) {
        steps.push({
          name,
          expect: expectText,
          actual: `threw: ${String(error.message ?? error)}`,
          pass: false,
          note: null,
          evidence: [],
        });
        throw new StepError(`${name}: ${String(error.message ?? error)}`);
      }
      steps.push({ name, expect: expectText, actual, pass, note, evidence: evidenceFiles });
      if (!pass) {
        throw new StepError(`${name}: expected ${expectText}; got ${actual}`);
      }
      return value;
    },
    info(name, note) {
      steps.push({ name, expect: 'recorded', actual: 'recorded', pass: true, note, evidence: [] });
    },
    evidenceFor(stepName, files) {
      const last = steps[steps.length - 1];
      const target = last !== undefined && last.name === stepName ? last : steps.find((s) => s.name === stepName);
      if (target === undefined) {
        steps.push({ name: stepName, expect: 'evidence attached', actual: 'evidence attached', pass: true, note: null, evidence: files });
        return;
      }
      target.evidence.push(...files);
    },
    steps,
  };
  return state;
}

/** Aggregate a journey outcome into the run record. */
export function outcome(journeyName, steps, error) {
  const failed = steps.filter((s) => !s.pass);
  return {
    journey: journeyName,
    status: error === null ? 'PASS' : 'FAIL',
    failedStep: error instanceof StepError ? error.message : error === null ? null : String(error.message ?? error),
    passedSteps: steps.filter((s) => s.pass).length,
    failedSteps: failed.length,
    steps,
  };
}
