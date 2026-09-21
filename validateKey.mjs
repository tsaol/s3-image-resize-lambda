// Pure key-validation logic — separated from the handler so tests
// don't need to load the sharp / AWS SDK dependencies.

const KEY_PATTERN = /^[a-zA-Z0-9._\-\/]+$/;
const ALLOWED_PREFIXES = ['photos/'];

export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  if (!KEY_PATTERN.test(key)) return false;
  if (key.includes('..')) return false;
  if (key.startsWith('/')) return false;
  if (key.startsWith('.')) return false;
  if (key.endsWith('/')) return false;
  if (key.includes('//')) return false;
  if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) return false;
  return true;
}
