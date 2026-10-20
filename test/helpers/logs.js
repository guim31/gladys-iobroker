// The integration's log lines at a given level, captured from the console the
// SDK logger writes to (LOG_LEVEL is read on every call).

/**
 * Start capturing; `stop()` restores the console and LOG_LEVEL and returns
 * the captured lines.
 * @param {import('node:test').TestContext} t
 * @param {string} [level]
 */
export function captureLogs(t, level = 'info') {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const record = (...args) => {
    lines.push(args.join(' '));
  };
  const log = t.mock.method(console, 'log', record);
  const error = t.mock.method(console, 'error', record);
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      log.mock.restore();
      error.mock.restore();
      process.env.LOG_LEVEL = previous;
    }
    return lines;
  };
  t.after(stop);
  return { lines, stop };
}
