import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingSuggestions } from '../public/combobox.js';
import { localityOptions, brandOptions, uomOptions } from '../public/lookups.js';

test('locality and brand suggestions match typed text without case or punctuation restrictions', () => {
  assert.deepEqual(matchingSuggestions(localityOptions,'godhan'),['Godhanpur']);
  assert.ok(matchingSuggestions(localityOptions,'bhatti').includes('Bhatti Road'));
  assert.ok(matchingSuggestions(localityOptions,'dc road').includes('D.C. Road'));
  assert.ok(matchingSuggestions(localityOptions,'nawa').includes('Nawapara'));
  assert.ok(matchingSuggestions(brandOptions,'sam').includes('Samsung'));
  assert.deepEqual(matchingSuggestions(brandOptions,''),[]);
  assert.deepEqual(matchingSuggestions(brandOptions,'A custom brand'),[]);
  assert.ok(localityOptions.length > 50);
  assert.ok(uomOptions.length > 40);
});
