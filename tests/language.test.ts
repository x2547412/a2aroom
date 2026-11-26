import test from 'node:test';
import assert from 'node:assert/strict';
import { languageSetting, resolveLanguage } from '../shared/language';

test('manual language overrides device preferences and system follows supported languages', () => {
  assert.equal(resolveLanguage(languageSetting('other=ja; a2aroom_language=en'), 'ja-JP'), 'en');
  assert.equal(resolveLanguage(languageSetting('a2aroom_language=invalid'), 'de, en;q=0.3, ja-JP;q=0.8'), 'ja');
  assert.equal(resolveLanguage('system', 'ja;q=0,fr'), 'en');
});
