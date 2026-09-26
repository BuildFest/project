// Read at call time, not import time, so tests can set process.env first and
// a missing optional feature doesn't stop the whole server from booting.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
