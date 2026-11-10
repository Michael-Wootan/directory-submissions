#!/usr/bin/env node
// Offline tests for listing detection, discovery filters, form field mapping
// and pitch building. No network, browser or API keys needed.
const assert = require('assert');
const path = require('path');
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
delete process.env.ANTHROPIC_API_KEY;
const d = require('../src/directory-submissions.js');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const fieldValue = meta => {
  for (const rule of d.FIELD_MAP) {
    if (rule.skip && rule.skip.test(meta)) continue;
    if (rule.re.test(meta)) return rule.val();
  }
  return null;
};

(async () => {
  await t('a directory page that mentions the site counts as listed', () => {
    assert.strictEqual(d.mentionsSite('<a href="https://www.acmesupply.example">Acme</a>'), true);
    assert.strictEqual(d.mentionsSite('<p>Some other company</p>'), false);
    assert.strictEqual(d.mentionsSite('acmesupplyXexample'), false);
  });

  await t('hostnames are normalized without www', () => {
    assert.strictEqual(d.hostnameOf('https://www.directory.example/add'), 'directory.example');
    assert.strictEqual(d.hostnameOf('not a url'), null);
  });

  await t('only pages with a submit signal are directory candidates', () => {
    assert.ok(d.SUBMIT_SIGNALS.test('Add your business to our directory'));
    assert.ok(d.SUBMIT_SIGNALS.test('Free listing for local companies'));
    assert.ok(!d.SUBMIT_SIGNALS.test('Read our latest articles'));
  });

  await t('social networks, marketplaces and search engines are never candidates', () => {
    for (const h of ['facebook.com', 'amazon.com', 'google.com', 'linkedin.com']) assert.ok(d.DOMAIN_BLOCKLIST.test(h), h);
    assert.ok(!d.DOMAIN_BLOCKLIST.test('directory.example'));
  });

  await t('form fields are mapped from their name, id or placeholder', () => {
    assert.strictEqual(fieldValue('company_name'), d.BUSINESS.name);
    assert.strictEqual(fieldValue('first_name'), d.BUSINESS.firstName);
    assert.strictEqual(fieldValue('last-name'), d.BUSINESS.lastName);
    assert.strictEqual(fieldValue('contact email'), d.BUSINESS.email);
    assert.strictEqual(fieldValue('website url'), d.BUSINESS.website);
    assert.strictEqual(fieldValue('description'), d.BUSINESS.description);
  });

  await t('fields it has no value for are left empty', () => {
    assert.strictEqual(fieldValue('phone'), null);
    assert.strictEqual(fieldValue('postal_code'), null);
  });

  await t('the pitch prompt carries the angle, the configured rules and the sign-off', () => {
    const p = { angle: 'a product feature pitch' };
    const prompt = d.buildPitchPrompt({ name: 'Example Food Magazine' }, p);
    assert.ok(prompt.includes('a product feature pitch'));
    assert.ok(prompt.includes('Do not make health claims.'));
    assert.ok(prompt.includes('Alex Morgan'));
  });

  await t('without an API key the pitch falls back to a template', async () => {
    const pitch = await d.buildMailtoPitch({ name: 'Example Food Magazine' });
    assert.ok(pitch.subject.includes('Acme Supply Co.'));
    assert.ok(pitch.body.includes('happy to send product details') && pitch.body.includes('Alex Morgan'));
    const generic = await d.buildMailtoPitch({ name: 'Unknown Site' });
    assert.ok(generic.body.includes('Unknown Site'));
  });

  console.log(`\n${n} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
