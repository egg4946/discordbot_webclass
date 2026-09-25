import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresOwner } from '../src/command-access.js';

test('unsubmitted commands are owner-only', () => {
  assert.equal(requiresOwner('webclass-unsubmitted'), true);
  assert.equal(requiresOwner('webclass-next'), true);
});

test('shared assignment commands remain public', () => {
  assert.equal(requiresOwner('webclass-all', true), false);
  assert.equal(requiresOwner('webclass-closest'), false);
  assert.equal(requiresOwner('webclass-status'), false);
});

test('filtering the shared list to unsubmitted assignments is owner-only', () => {
  assert.equal(requiresOwner('webclass-all', false), true);
});

test('mute commands are owner-only', () => {
  assert.equal(requiresOwner('webclass-mute'), true);
  assert.equal(requiresOwner('webclass-unmute'), true);
  assert.equal(requiresOwner('webclass-mutes'), true);
});
