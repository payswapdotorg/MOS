/**
 * E2E harness browser wrapper (VER-001) — thin, auditable shell around the
 * agent-browser CLI (headless browser automation). One isolated agent-browser
 * session per journey. Command arguments containing secret fill values are
 * never recorded (the wrapper logs refs/roles, not values).
 */

import { spawnSync } from 'node:child_process';

const BINARY = process.env.MOS_E2E_BROWSER_BIN ?? 'agent-browser';

export class BrowserError extends Error {
  constructor(message, { stdout, stderr } = {}) {
    super(message);
    this.name = 'BrowserError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * @param {string} sessionName isolated agent-browser session
 * @param {number} timeoutMs default per-command timeout (browser steps need
 *   generous timeouts; production cold starts can take tens of seconds)
 */
export function browserSession(sessionName, timeoutMs = 60000) {
  const session = `mos-e2e-${sessionName}`;

  function run(args, { timeout = timeoutMs } = {}) {
    const result = spawnSync(BINARY, ['--session', session, ...args], {
      timeout,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) {
      throw new BrowserError(`agent-browser ${args.join(' ')} failed to start: ${String(result.error)}`);
    }
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    // agent-browser signals failures with a non-zero exit code and a "✗"
    // line on stderr (verified live). The stdout check is deliberately NOT
    // text-based: page snapshots legitimately contain arbitrary page text.
    if (result.status !== 0) {
      throw new BrowserError(`agent-browser ${args.join(' ')} exited ${result.status}`, { stdout, stderr });
    }
    if (/^\s*✗/m.test(stderr)) {
      throw new BrowserError(`agent-browser ${args.join(' ')} reported a failure`, { stdout, stderr });
    }
    return stdout;
  }

  const api = {
    session,
    open(url) {
      return run(['open', url]);
    },
    reload() {
      return run(['reload']);
    },
    close() {
      // Closing is best-effort (the session may already be gone).
      const result = spawnSync(BINARY, ['--session', session, 'close'], { timeout: 30000, encoding: 'utf8' });
      return result.stdout ?? '';
    },
    /**
     * Default is the FULL compact a11y tree: interactive-only snapshots
     * ("-i") prune static text (card titles, ledger rows, badges), which
     * content assertions need. Pass { interactive: true } for elements+refs
     * only (interaction planning).
     */
    snapshot({ interactive = false, compact = true } = {}) {
      const args = ['snapshot'];
      if (interactive) args.push('-i');
      if (compact) args.push('-c');
      return run(args);
    },
    click(ref) {
      return run(['click', ref]);
    },
    fill(ref, value) {
      return run(['fill', ref, value]);
    },
    press(key) {
      return run(['press', key]);
    },
    /** Semantic locators (stable across runs, unlike refs): find by role. */
    findByRole(role, action, { name, text } = {}) {
      const args = ['find', 'role', role, action];
      if (name !== undefined) args.push('--name', name);
      if (text !== undefined) args.push('--text', text);
      return run(args);
    },
    findByText(text, action) {
      return run(['find', 'text', text, action]);
    },
    findByLabel(label, action, value) {
      const args = ['find', 'label', label, action];
      if (value !== undefined) args.push(value);
      return run(args);
    },
    waitForText(text, { timeout } = {}) {
      return run(['wait', '--text', text], { timeout });
    },
    waitForLoad({ timeout } = {}) {
      return run(['wait', '--load', 'networkidle'], { timeout });
    },
    wait(ms) {
      return run(['wait', String(ms)]);
    },
    getUrl() {
      return run(['get', 'url']).trim();
    },
    getTitle() {
      return run(['get', 'title']).trim();
    },
    eval(js) {
      return run(['eval', js]);
    },
    console() {
      return run(['console']);
    },
    errors() {
      return run(['errors']);
    },
    setViewport(width, height) {
      return run(['set', 'viewport', String(width), String(height)]);
    },
    screenshot(filePath, { full = false } = {}) {
      const args = ['screenshot', filePath];
      if (full) args.push('--full');
      return run(args, { timeout: timeoutMs });
    },
    networkRequests() {
      return run(['network', 'requests']);
    },
  };

  return api;
}

/**
 * Parse an `eval` result reliably. agent-browser prints the eval result
 * JSON-encoded: a returned JSON string appears as a QUOTED, escaped string
 * (e.g. `"{\"a\":1}"`), while raw primitives print bare (`2`, `true`).
 * Objects returned directly print as bare JSON.
 */
export function parseEvalResult(raw) {
  const text = String(raw).trim();
  if (text.startsWith('"')) {
    // A JSON string: one parse yields the inner string, a second the value.
    const inner = JSON.parse(text);
    return typeof inner === 'string' && (inner.startsWith('{') || inner.startsWith('['))
      ? JSON.parse(inner)
      : inner;
  }
  return JSON.parse(text);
}

/** Parse "- name [ref=eN]" lines out of a snapshot. */
export function snapshotRefs(snapshotText) {
  const refs = new Map();
  for (const match of snapshotText.matchAll(/- (.*?) \[([^\]]* )?ref=(e\d+)\]/g)) {
    refs.set(match[3], match[1].trim());
  }
  return refs;
}

/** True when the page errors report is empty (agent-browser prints "No page errors"). */
export function pageErrorsFrom(output) {
  if (output.trim() === '' || /no page errors/i.test(output)) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
