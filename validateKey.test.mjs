// Unit tests for validateKey — run before deploying
// node --test validateKey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKey } from './validateKey.mjs';

const cases = [
  // Valid
  ['photos/cat.jpg',                     true,  'basic photo'],
  ['photos/2026/06/abc-123.png',         true,  'nested dirs'],
  ['photos/some_file.webp',              true,  'underscore ok'],
  ['photos/A.avif',                      true,  'uppercase ok'],

  // Invalid — path traversal
  ['../secret',                          false, 'parent dir'],
  ['photos/../../etc/passwd',            false, 'nested traversal'],
  ['/etc/passwd',                        false, 'absolute path'],
  ['..%2fadmin',                         false, 'URL-encoded (has %, fails charset)'],
  ['./hidden',                           false, 'starts with dot'],
  ['photos//double',                     false, 'double slash'],

  // Invalid — outside allowed prefix
  ['secret/keys.json',                   false, 'not under photos/'],
  ['uploads/x.jpg',                      false, 'not under photos/'],
  ['x.jpg',                              false, 'no prefix'],

  // Invalid — charset
  ['photos/cat jpg',                     false, 'space'],
  ['photos/<script>',                    false, 'angle brackets'],
  ['photos/cat.jpg\x00.txt',             false, 'null byte'],
  ['photos/café.jpg',                    false, 'non-ASCII (accept? not per current pattern)'],

  // Invalid — edge
  ['',                                   false, 'empty'],
  ['a'.repeat(1025),                     false, 'too long'],
  ['photos/',                            false, 'ends with slash (dir)'],
];

for (const [input, expected, note] of cases) {
  test(`validateKey(${JSON.stringify(input).slice(0, 60)}) = ${expected}  [${note}]`,
    () => assert.equal(validateKey(input), expected));
}
