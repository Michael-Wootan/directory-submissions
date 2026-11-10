#!/usr/bin/env node
/**
 * directory-submissions.js: directory prospector, listing tracker and submitter
 *
 * Each weekly run:
 *   1. DISCOVERY   searches for new business directories with free listings
 *                  and dedupes them against every known domain.
 *   2. VERIFY      re-checks submitted entries; if the directory page now
 *                  mentions the site, the entry is marked 'listed'.
 *   3. PITCH       emails targets that only accept submissions by email, once.
 *   4. AUTO-SUBMIT (optional, off by default) a headless browser opens submit
 *                  pages and fills simple free forms. Anything with a CAPTCHA,
 *                  account creation, payment, or required fields it cannot
 *                  fill is queued as 'needs-review' with the reason.
 *   5. REPORT      emails a digest: submitted, newly discovered, the
 *                  needs-review queue, and the full status table.
 *
 * State: state/directory-status.json. A screenshot of every submit attempt
 * lands in state/screenshots/.
 *
 * Usage:
 *   node src/directory-submissions.js              full run + email report
 *   node src/directory-submissions.js --check      no submissions, no email
 *   node src/directory-submissions.js --no-submit  discovery + report only
 *
 * Env: GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_NOTIFY, SUBMIT_LIMIT,
 *      ANTHROPIC_API_KEY (optional, AI-written email pitches),
 *      DIRECTORY_AUTOSUBMIT ('true' to enable browser auto-submit; default off)
 */

require('dotenv').config({ quiet: true });
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const CHECK_ONLY = process.argv.includes('--check');
const NO_SUBMIT = process.argv.includes('--no-submit') || CHECK_ONLY;
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
const STATE_DIR = process.env.STATE_DIR || path.resolve(__dirname, '..', 'state');
const LOG_FILE = path.join(STATE_DIR, 'directory-status.json');
const SCREENSHOT_DIR = path.join(STATE_DIR, 'screenshots');
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const EMAIL_NOTIFY = process.env.EMAIL_NOTIFY || GMAIL_USER;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLIENT_ID = process.env.CLIENT_ID || 'directory-prospector/1.0';
const SUBMIT_LIMIT = parseInt(process.env.SUBMIT_LIMIT || '5', 10);
const AUTOSUBMIT = process.env.DIRECTORY_AUTOSUBMIT === 'true';

// ── Profile: config/directories.json (falls back to the example) ─────────────
//   business:         what gets typed into listing forms and email pitches
//   directories:      curated seed list [{ name, url, dr, category, submitUrl, notes }]
//   discoveryQueries: search queries, four per run, rotated weekly
//   emailPitches:     per-target subject, angle and fallback line for mailto targets
//   pitchRules:       hard rules injected into the pitch prompt
//   categoryTerms:    regex fragments used to pick an option in category dropdowns
function loadConfig() {
  for (const f of ['directories.json', 'directories.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/directories.json');
}
const CONFIG = loadConfig();
const BUSINESS = CONFIG.business;
const SITE_URL = (BUSINESS.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const DIRECTORIES = (CONFIG.directories || []).map(d => ({ status: 'todo', ...d }));
const DISCOVERY_QUERIES = CONFIG.discoveryQueries || [];
const MAILTO_PITCHES = CONFIG.emailPitches || {};
const CATEGORY_RE = new RegExp((CONFIG.categoryTerms || ['retail', 'shopping', 'ecommerce', 'other']).join('|'), 'i');

// Social networks, marketplaces, search engines and publishers are never directories
const DOMAIN_BLOCKLIST = /reddit|facebook|twitter|x\.com|linkedin|instagram|pinterest|youtube|tiktok|quora|medium\.com|wikipedia|amazon|ebay|etsy|yelp\.|google\.|bing\.|microsoft|shopify\.com|forbes|nytimes|\.gov$|\.edu$/i;

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadStatus() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return {}; }
}
function saveStatus(data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchUrl(url, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': CLIENT_ID, 'Accept': 'text/html' },
      timeout: 12000,
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(fetchUrl(loc, maxRedirects - 1));
      }
      let body = '';
      res.on('data', d => { if (body.length < 500000) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function bingSearch(query, count = 15) {
  return new Promise((resolve, reject) => {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`;
    const req = https.get(url, {
      headers: { 'User-Agent': CLIENT_ID },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const urls = new Set();
        let m;
        const h2Regex = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>/g;
        while ((m = h2Regex.exec(body)) !== null) {
          if (m[1].startsWith('http') && !/bing|microsoft/.test(m[1])) urls.add(m[1]);
        }
        resolve(Array.from(urls));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── 1. Discovery ──────────────────────────────────────────────────────────────
const SUBMIT_SIGNALS = /add (your )?(business|listing|company|site|store|brand)|submit (your )?(business|site|listing|brand|company|store)|free listing|list your (business|company|brand|site)|claim your (business|listing)|register your (business|company)/i;

async function discoverDirectories(knownDomains) {
  const weekNumber = Math.floor(Date.now() / (7 * 86400 * 1000));
  const queries = [];
  for (let i = 0; i < Math.min(4, DISCOVERY_QUERIES.length); i++) queries.push(DISCOVERY_QUERIES[(weekNumber + i) % DISCOVERY_QUERIES.length]);

  const discovered = [];
  for (const q of queries) {
    console.log(`\n🔍 Discovery search: ${q}`);
    let urls = [];
    try { urls = await bingSearch(q); } catch (e) { console.log(`  ⚠️ ${e.message}`); continue; }
    for (const u of urls) {
      const host = hostnameOf(u);
      if (!host || knownDomains.has(host) || DOMAIN_BLOCKLIST.test(host)) continue;
      knownDomains.add(host); // don't recheck within this run
      try {
        const { status, body } = await fetchUrl(u);
        if (status !== 200) continue;
        if (!SUBMIT_SIGNALS.test(body)) continue;
        // find the most likely submit link
        let submitUrl = null;
        const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]{0,80})<\/a>/gi;
        let lm;
        while ((lm = linkRegex.exec(body)) !== null) {
          if (/add|submit|list.your|claim|register|join/i.test(lm[1] + ' ' + lm[2])) {
            submitUrl = lm[1].startsWith('http') ? lm[1] : new URL(lm[1], u).href;
            break;
          }
        }
        const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
        discovered.push({
          name: host,
          title: titleMatch ? titleMatch[1].trim().slice(0, 80) : host,
          url: u,
          submitUrl: submitUrl || u,
          category: 'discovered',
          dr: null,
          status: 'discovered',
          foundVia: q,
          discoveredAt: new Date().toISOString(),
        });
        console.log(`  ✅ New directory candidate: ${host}`);
      } catch { /* skip */ }
      await sleep(500);
    }
    await sleep(1500);
  }
  return discovered;
}

// ── 2. Verify submitted → listed ──────────────────────────────────────────────
function mentionsSite(body) {
  if (!SITE_URL) return false;
  return new RegExp(SITE_URL.replace(/\./g, '\\.'), 'i').test(body);
}

async function verifyListings(entries) {
  const nowListed = [];
  for (const e of entries) {
    // 'needs-review' entries are checked too: those are cleared by hand, so a
    // listing someone creates manually flips to 'listed' here on a later run.
    if (!['submitted', 'needs-review'].includes(e.status) || !e.url || e.url.startsWith('mailto:')) continue;
    try {
      const { body } = await fetchUrl(e.url);
      if (mentionsSite(body)) {
        e.status = 'listed';
        e.listedAt = new Date().toISOString();
        nowListed.push(e.name);
        console.log(`  🎉 Now live: ${e.name}`);
      }
    } catch { /* skip */ }
    await sleep(500);
  }
  return nowListed;
}

// ── 2b. Email pitches for mailto-only targets ─────────────────────────────────
function callClaude(prompt, maxTokens = 500) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.content && j.content[0] && j.content[0].text) resolve(j.content[0].text.trim());
          else reject(new Error(j.error ? j.error.message : 'empty Claude response'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function signOff() {
  return [BUSINESS.contactName, [BUSINESS.contactTitle, BUSINESS.name].filter(Boolean).join(', '), BUSINESS.email].filter(Boolean).join('\n');
}

function buildPitchPrompt(entry, p) {
  const rules = ['120-180 words, warm and professional, no hype or buzzwords.', ...(CONFIG.pitchRules || [])];
  return `Write the body of a short outreach email (120-180 words, plain text, no subject line) from ${BUSINESS.contactName}, ${BUSINESS.contactTitle || 'founder'} of ${BUSINESS.name} (${BUSINESS.website}). About the company: ${BUSINESS.description}

The email is ${p.angle}.

Hard rules:
${rules.map(r => `- ${r}`).join('\n')}
- End with this sign-off:
${signOff()}

Write ONLY the email body text.`;
}

async function buildMailtoPitch(entry) {
  const p = MAILTO_PITCHES[entry.name] || {
    subject: `Partnership inquiry: ${BUSINESS.name}`,
    angle: `a short, specific introduction of ${BUSINESS.name} for ${entry.name}, asking how brands can be featured or listed`,
    staticLine: `I think ${BUSINESS.name} could be a strong fit for ${entry.name} and would love to learn how brands can be featured.`,
  };

  let body = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      body = await callClaude(buildPitchPrompt(entry, p));
    } catch (e) {
      console.log(`  ⚠️ AI pitch failed for ${entry.name} (${e.message}), using template`);
    }
  }

  if (!body) {
    body = `Hi there,

I'm ${BUSINESS.contactName}, ${BUSINESS.contactTitle || 'founder'} of ${BUSINESS.name} (${BUSINESS.website}). ${BUSINESS.description}

${p.staticLine}

Would love to connect if this sounds like a fit. Happy to share more details, images, or anything else useful.

Best,
${signOff()}`;
  }

  return { subject: p.subject, body };
}

// ── 3. Auto-submit via Playwright ─────────────────────────────────────────────
const FIELD_MAP = [
  { re: /company|business.?name|brand|organi[sz]ation|store.?name|site.?name|listing.?title|^name$|\bname\b/i, val: () => BUSINESS.name, skip: /user.?name|last.?name|first.?name|nick/i },
  { re: /first.?name/i, val: () => BUSINESS.firstName },
  { re: /last.?name|surname/i, val: () => BUSINESS.lastName },
  { re: /e-?mail/i, val: () => BUSINESS.email },
  { re: /website|url|site|domain|link/i, val: () => BUSINESS.website },
  { re: /desc|about|bio|summary|message|details|comment/i, val: () => BUSINESS.description },
];

async function attemptSubmit(browser, entry) {
  const result = { name: entry.name, url: entry.submitUrl, outcome: 'needs-review', reason: '' };
  const page = await browser.newPage();
  const shotName = entry.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  try {
    await page.goto(entry.submitUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const html = (await page.content()).toLowerCase();

    if (/recaptcha|hcaptcha|cf-turnstile|captcha/i.test(html)) {
      result.reason = 'CAPTCHA on form'; return result;
    }
    if (await page.$('input[type="password"]')) {
      result.reason = 'Account creation / login required'; return result;
    }
    if (/\$\d+|per (month|year)|pricing plan|paid listing|premium listing only/i.test(html) && !/free listing|free plan|list for free/i.test(html)) {
      result.reason = 'Appears to be paid-only'; return result;
    }

    const form = await page.$('form');
    if (!form) { result.reason = 'No form found (may need account or manual steps)'; return result; }

    // Fill fields
    const fields = await form.$$('input[type="text"], input[type="email"], input[type="url"], input:not([type]), textarea');
    let filled = 0;
    for (const f of fields) {
      const meta = ((await f.getAttribute('name')) || '') + ' ' +
                   ((await f.getAttribute('id')) || '') + ' ' +
                   ((await f.getAttribute('placeholder')) || '') + ' ' +
                   ((await f.getAttribute('aria-label')) || '');
      const type = (await f.getAttribute('type')) || 'text';
      let value = null;
      if (type === 'email') value = BUSINESS.email;
      else if (type === 'url') value = BUSINESS.website;
      else {
        for (const rule of FIELD_MAP) {
          if (rule.skip && rule.skip.test(meta)) continue;
          if (rule.re.test(meta)) { value = rule.val(); break; }
        }
      }
      if (value) { try { await f.fill(value); filled++; } catch { /* skip */ } }
    }

    // Category selects
    for (const sel of await form.$$('select')) {
      try {
        const opts = await sel.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent })));
        const match = opts.find(o => CATEGORY_RE.test(o.t));
        if (match) await sel.selectOption(match.v);
      } catch { /* skip */ }
    }

    // Required terms checkbox
    for (const cb of await form.$$('input[type="checkbox"][required]')) {
      try { await cb.check(); } catch { /* skip */ }
    }

    // Bail if required fields we can't fill remain empty (phone, address, etc.)
    const unfillable = await form.$$eval('input[required], textarea[required]',
      els => els.filter(e => !e.value && e.type !== 'checkbox' && e.type !== 'hidden').map(e => e.name || e.id || e.placeholder || e.type));
    if (unfillable.length > 0) {
      result.reason = `Required fields need manual input: ${unfillable.slice(0, 4).join(', ')}`;
      return result;
    }
    if (filled === 0) { result.reason = 'Could not map any form fields'; return result; }

    // Submit
    const btn = await form.$('button[type="submit"], input[type="submit"], button:not([type])');
    if (!btn) { result.reason = 'No submit button found'; return result; }
    await btn.click();
    await page.waitForTimeout(6000);

    const after = (await page.content()).toLowerCase();
    if (/thank|success|submitted|received|we.ll review|confirmation|check your email/i.test(after)) {
      result.outcome = 'submitted';
      result.reason = `Form submitted (${filled} fields)`;
    } else {
      result.reason = 'Submitted but no confirmation detected: verify manually';
      result.outcome = 'submitted-unconfirmed';
    }
    return result;
  } catch (e) {
    result.reason = `Error: ${e.message.slice(0, 120)}`;
    return result;
  } finally {
    try { await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${shotName}.png`), fullPage: false }); } catch { /* skip */ }
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Directory Prospector + Submitter [${new Date().toISOString()}]\n`);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const saved = loadStatus();

  // Merge curated seed list with saved state
  const entries = DIRECTORIES.map(d => ({ ...d, ...(saved[d.name] || {}) }));
  // Bring in previously discovered entries
  for (const [name, e] of Object.entries(saved)) {
    if (!DIRECTORIES.find(d => d.name === name)) entries.push({ name, ...e });
  }

  const knownDomains = new Set(entries.flatMap(e => [hostnameOf(e.url), hostnameOf(e.submitUrl)]).filter(Boolean));
  if (SITE_URL) knownDomains.add(SITE_URL);

  // 1. Discover
  const discovered = await discoverDirectories(knownDomains);
  entries.push(...discovered);

  // 2. Verify
  console.log(`\n🔎 Verifying submitted listings...`);
  const nowListed = await verifyListings(entries);

  // 2b. Email-pitch mailto-only targets (one-time: status flip prevents resend)
  const mailtoPitched = [];
  if (!NO_SUBMIT && GMAIL_PASS) {
    const mailtoTargets = entries.filter(e => e.status === 'todo' && e.submitUrl && e.submitUrl.startsWith('mailto:'));
    if (mailtoTargets.length > 0) {
      console.log(`\n📧 Pitching ${mailtoTargets.length} mailto-only target(s) via email...`);
      const pitchTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      });
      for (const entry of mailtoTargets) {
        const to = entry.submitUrl.replace(/^mailto:/, '');
        try {
          const pitch = await buildMailtoPitch(entry);
          await pitchTransporter.sendMail({
            from: `"${BUSINESS.contactName}, ${BUSINESS.name}" <${GMAIL_USER}>`,
            replyTo: BUSINESS.email,
            to,
            subject: pitch.subject,
            text: pitch.body,
          });
          entry.status = 'submitted';
          entry.submittedAt = new Date().toISOString();
          entry.notes = 'pitched via email';
          mailtoPitched.push(`${entry.name} (${to})`);
          console.log(`  ✅ Pitched ${entry.name} → ${to}`);
        } catch (e) {
          console.log(`  ⚠️ Pitch failed for ${entry.name}: ${e.message}`);
        }
        await sleep(1500);
      }
    }
  }

  // 3. Auto-submit (gated: in production it never produced a confirmed
  //    submission, so it is off unless DIRECTORY_AUTOSUBMIT=true)
  const submissions = [];
  if (!NO_SUBMIT && !AUTOSUBMIT) {
    console.log(`\n🤖 Auto-submit disabled (set DIRECTORY_AUTOSUBMIT=true to enable)`);
  }
  if (!NO_SUBMIT && AUTOSUBMIT) {
    const candidates = entries.filter(e =>
      (e.status === 'todo' || e.status === 'discovered') &&
      e.submitUrl && !e.submitUrl.startsWith('mailto:')
    );
    // Discovered first (that's the dynamic part), then curated by DR
    candidates.sort((a, b) => (b.status === 'discovered') - (a.status === 'discovered') || (b.dr || 0) - (a.dr || 0));

    if (candidates.length > 0) {
      console.log(`\n🤖 Attempting up to ${SUBMIT_LIMIT} auto-submissions...`);
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true });
      for (const entry of candidates.slice(0, SUBMIT_LIMIT)) {
        console.log(`  → ${entry.name} (${entry.submitUrl})`);
        const r = await attemptSubmit(browser, entry);
        console.log(`    ${r.outcome}: ${r.reason}`);
        submissions.push(r);
        if (r.outcome === 'submitted' || r.outcome === 'submitted-unconfirmed') {
          entry.status = 'submitted';
          entry.submittedAt = new Date().toISOString();
          entry.notes = r.reason;
        } else {
          entry.status = 'needs-review';
          entry.notes = r.reason;
        }
        await sleep(3000);
      }
      await browser.close();
    }
  }

  // Nag-once: only entries NEWLY entering needs-review get the "Needs you" table
  const newReview = entries.filter(e => e.status === 'needs-review' && !e.nagged);
  newReview.forEach(e => { e.nagged = true; });

  // Persist
  entries.forEach(e => {
    saved[e.name] = {
      status: e.status, dr: e.dr, url: e.url, submitUrl: e.submitUrl,
      category: e.category, notes: e.notes || '', submittedAt: e.submittedAt || null,
      listedAt: e.listedAt || null, foundVia: e.foundVia || null, title: e.title || null,
      nagged: e.nagged || false,
    };
  });
  saveStatus(saved);

  // Stats
  const byStatus = s => entries.filter(e => e.status === s);
  const listed = byStatus('listed'), submitted = byStatus('submitted'),
        todo = byStatus('todo'), review = byStatus('needs-review'), disc = byStatus('discovered');

  console.log(`\n📊 Listed: ${listed.length} | Submitted: ${submitted.length} | Needs review: ${review.length} | To-do: ${todo.length} | Discovered: ${disc.length}`);
  console.log(`   This run: new: ${discovered.length}, auto-submitted: ${submissions.filter(s => s.outcome.startsWith('submitted')).length}, pitched: ${mailtoPitched.length}, went live: ${nowListed.length}\n`);

  if (CHECK_ONLY) return;
  if (!GMAIL_PASS) { console.error('❌ GMAIL_APP_PASSWORD not set'); process.exit(1); }

  const row = (e, i) => `
    <tr style="border-bottom:1px solid #eee;background:${i % 2 ? '#fafafa' : 'white'}">
      <td style="padding:6px"><a href="${e.url}">${e.name}</a></td>
      <td style="text-align:center">${e.dr || '-'}</td>
      <td style="text-align:center">${e.status}</td>
      <td style="font-size:11px;color:#666">${e.notes || e.foundVia || ''}</td>
    </tr>`;

  const emailHtml = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:780px;margin:0 auto;padding:20px">
<h2 style="color:#1a1a2e">📋 Directory Prospector: ${new Date().toLocaleDateString('en-CA')}</h2>
<div style="display:flex;gap:10px;margin:16px 0;flex-wrap:wrap">
  <div style="background:#27ae60;color:white;padding:10px 18px;border-radius:8px;text-align:center"><strong>${listed.length}</strong><br>Listed</div>
  <div style="background:#f39c12;color:white;padding:10px 18px;border-radius:8px;text-align:center"><strong>${submitted.length}</strong><br>Submitted</div>
  <div style="background:#8e44ad;color:white;padding:10px 18px;border-radius:8px;text-align:center"><strong>${discovered.length}</strong><br>New This Run</div>
  <div style="background:#e74c3c;color:white;padding:10px 18px;border-radius:8px;text-align:center"><strong>${newReview.length}</strong><br>Need You</div>
</div>

${nowListed.length ? `<h3 style="color:#27ae60">🎉 Links gone live</h3><p>${nowListed.join(', ')}</p>` : ''}

${mailtoPitched.length ? `<h3 style="color:#2980b9">📧 Pitched via email</h3><p>${mailtoPitched.join(', ')}</p>` : ''}

${submissions.length ? `<h3 style="color:#f39c12">🤖 Auto-submission attempts (screenshots in the workflow artifact)</h3>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th style="padding:6px;text-align:left">Directory</th><th>Outcome</th><th style="text-align:left">Detail</th></tr>
${submissions.map((s, i) => `<tr style="border-bottom:1px solid #eee;background:${i % 2 ? '#fafafa' : 'white'}">
  <td style="padding:6px"><a href="${s.url}">${s.name}</a></td>
  <td style="text-align:center">${s.outcome.startsWith('submitted') ? '✅' : '👤'} ${s.outcome}</td>
  <td style="font-size:11px;color:#666">${s.reason}</td></tr>`).join('')}
</table>` : ''}

${discovered.length ? `<h3 style="color:#8e44ad">🔍 Newly discovered directories</h3>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th style="padding:6px;text-align:left">Site</th><th style="text-align:left">Found via</th></tr>
${discovered.map((d, i) => `<tr style="border-bottom:1px solid #eee;background:${i % 2 ? '#fafafa' : 'white'}">
  <td style="padding:6px"><a href="${d.url}">${d.title || d.name}</a></td>
  <td style="font-size:11px;color:#666">${d.foundVia}</td></tr>`).join('')}
</table>` : ''}

${newReview.length ? `<h3 style="color:#e74c3c">👤 Needs you: new this run (CAPTCHA / account / manual fields)</h3>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th style="padding:6px;text-align:left">Directory</th><th>DR</th><th style="text-align:left">Submit</th><th style="text-align:left">Why</th></tr>
${newReview.map((e, i) => `<tr style="border-bottom:1px solid #eee;background:${i % 2 ? '#fafafa' : 'white'}">
  <td style="padding:6px"><strong>${e.name}</strong></td><td style="text-align:center">${e.dr || '-'}</td>
  <td><a href="${e.submitUrl}" style="font-size:11px">Submit →</a></td>
  <td style="font-size:11px;color:#666">${e.notes}</td></tr>`).join('')}
</table>` : ''}

${review.length - newReview.length > 0 ? `<p style="color:#666;font-size:13px">👤 ${review.length - newReview.length} in manual review, tracked until they go live.</p>` : ''}

<h3 style="margin-top:24px">📊 Full status</h3>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th style="padding:6px;text-align:left">Directory</th><th>DR</th><th>Status</th><th style="text-align:left">Notes</th></tr>
${entries.sort((a, b) => (b.dr || 0) - (a.dr || 0)).map(row).join('')}
</table>

<hr style="margin:24px 0"><p style="font-size:11px;color:#999">Directory prospector. State in directory-status.json</p>
</body></html>`;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"${BUSINESS.name} Directory Bot" <${GMAIL_USER}>`,
    to: EMAIL_NOTIFY,
    subject: `[${BUSINESS.name}] Directories: ${submissions.filter(s => s.outcome.startsWith('submitted')).length} auto-submitted, ${mailtoPitched.length} pitched, ${discovered.length} discovered, ${newReview.length} need you: ${new Date().toLocaleDateString('en-CA')}`,
    html: emailHtml,
  });
  console.log(`✅ Report emailed to ${EMAIL_NOTIFY}\n`);
}

if (require.main === module) {
  main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
}

module.exports = { hostnameOf, mentionsSite, buildPitchPrompt, buildMailtoPitch, signOff, SUBMIT_SIGNALS, DOMAIN_BLOCKLIST, FIELD_MAP, BUSINESS };
