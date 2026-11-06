import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAttack, hasActor, strip, normalize, parseChannel, parseNews, chunk } from '../monitor.mjs';

test('matches common headline phrasings', () => {
  for (const t of [
    'Israel strikes Iran',
    'US launches airstrikes on Iranian nuclear site at Natanz',
    'Explosions heard in Tehran',
    'Israeli drones attack Isfahan',
  ]) assert.ok(isAttack(t), t);
  assert.ok(hasActor('Israel strikes Iran'));
  assert.ok(hasActor('U.S. strikes Iran'));
});

test('pronoun "us" is not an actor', () => {
  assert.equal(hasActor('Iran tells us it will respond to attack'), false);
  assert.equal(hasActor('Join us for a talk on Tehran'), false);
});

test('ignores unrelated text', () => {
  assert.equal(isAttack('Tehran stock market rises'), false);
  assert.equal(isAttack('Israel strikes Gaza'), false);
});

test('Persian matching with Arabic letter variants', () => {
  assert.ok(isAttack('صدای انفجار در تهران'));
  assert.ok(isAttack(normalize('حمله به اصفهان').replace(/ی/g, 'ي')));
  assert.ok(hasActor('حمله اسرائیل به ایران'));
  assert.ok(hasActor('حمله اسرائيل به ايران')); // Arabic yeh
});

test('strip decodes entities', () => {
  assert.equal(strip('a&amp;b &#1575; &#x627; <b>x</b><br/>y'), 'a&b ا ا x y');
});

test('parseChannel', () => {
  const html = `<div class="tgme_widget_message_wrap"><div data-post="Chan/12">
    <div class="tgme_widget_message_text js-message_text">Explosion in <b>Tehran</b></div>
    <time datetime="2026-11-06T10:00:00+00:00"></time></div></div>`;
  const [p] = parseChannel(html);
  assert.equal(p.id, 'Chan/12');
  assert.equal(p.text, 'Explosion in Tehran');
  assert.equal(p.ts, Date.parse('2026-11-06T10:00:00Z'));
});

test('parseNews strips publisher suffix', () => {
  const xml = `<rss><channel><item><title>Israel strikes Iran - Reuters</title>
    <link>https://x/1</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate>
    <source url="https://reuters.com">Reuters</source></item></channel></rss>`;
  const [it] = parseNews(xml);
  assert.equal(it.title, 'Israel strikes Iran');
  assert.equal(it.publisher, 'Reuters');
});

test('chunk splits long messages', () => {
  const parts = chunk('a\n'.repeat(5000), 4000);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4000));
});
