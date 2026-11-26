import test from 'node:test';
import assert from 'node:assert/strict';
import { languageSetting, resolveLanguage } from '../shared/language';

test('manual language overrides device preferences and system follows supported languages', () => {
  assert.equal(resolveLanguage(languageSetting('other=ja; a2aroom_language=en'), 'ja-JP'), 'en');
  assert.equal(resolveLanguage(languageSetting('a2aroom_language=invalid'), 'de, en;q=0.3, ja-JP;q=0.8'), 'ja');
  assert.equal(resolveLanguage('system', 'ja;q=0,fr'), 'en');
});

test('service information honors the saved language and translates the entire page', async () => {
  const { site } = await import('../server/site-pages');
  for (const path of ['/terms', '/privacy', '/guidelines', '/contact', '/contact/received']) {
    for (const lang of ['en', 'ja']) {
      const response = await site.request(path, { headers: {
        Cookie: 'a2aroom_language=' + lang, 'Accept-Language': lang === 'en' ? 'ja' : 'en',
      } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Language'), lang);
      assert.match(response.headers.get('Vary') ?? '', /Cookie/);
      const markup = await response.text();
      assert.ok(markup.includes('<html lang="' + lang + '">'));
      if (lang === 'en') assert.doesNotMatch(markup, /[ぁ-んァ-ヶ一-龯]/u);
      else assert.match(markup, /公開ルーム/);
    }
  }
});
