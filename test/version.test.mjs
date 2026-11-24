import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveVersion } from '../version.mjs';

test('effective version is stable or stamped with the source commit', () => {
  const base = { version: '0.2.0' };
  const beta = { ...base, perchReleaseChannel: 'beta' };
  const commit = '123456789abc0123456789abcdef0123456789ab';
  assert.equal(effectiveVersion(base), '0.2.0');
  assert.equal(effectiveVersion(beta, commit), '0.2.0-beta-123456789abc');
  assert.equal(effectiveVersion({ ...beta, version: '0.2.0-beta-123456789abc' }), '0.2.0-beta-123456789abc');
  assert.throws(() => effectiveVersion(beta), /Git commit/);
  assert.throws(() => effectiveVersion(beta, '123456789abG'), /Git commit/);
  assert.throws(() => effectiveVersion({ version: '01.2.0' }), /package version/);
  assert.throws(() => effectiveVersion({ ...base, perchReleaseChannel: 'other' }), /release channel/);
});
