// The test-only credential store does not belong in OMP/Git children: a session
// pool can exceed Linux execve's per-string limit. Keep the parent environment intact.
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('TELEGRAM_TEST_')) env[key] = value;
  }
  return env;
}
