/**
 * Test-only type aliases for the jobs unit-test fixtures (keeps the
 * override helpers in jobs.test.ts readable without importing the whole
 * /field-agents record machinery — the override shape is PARTIAL: the
 * helper merges it over the base fixture).
 */

export type JobEligibilitySpecOverride = {
  specialization?: string;
  requiredCapabilities?: readonly string[];
  territory?: { kind: string; value: string } | null;
  availability?: { dayOfWeek: number; startMinute: number; endMinute: number };
};
