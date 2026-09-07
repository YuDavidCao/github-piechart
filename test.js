// Runnable check: node test.js  (writes out.svg)  — set GITHUB_TOKEN to avoid the 60/hr anon limit.
const assert = require('assert');
const handler = require('./api/pie.js');

const call = url => new Promise(done => {
  const headers = {};
  handler({ url }, {
    setHeader: (k, v) => (headers[k] = v),
    end: body => done({ headers, body }),
  });
});

// caption + legend must stay inside the card
const inside = svg => {
  const h = +svg.match(/height="(\d+)"/)[1];
  for (const [, y] of svg.matchAll(/<text[^>]*\by="([\d.]+)"/g)) assert.ok(+y < h - 4, `text at y=${y} escapes card height ${h}`);
  return h;
};

(async () => {
  const bad = await call('/api/pie?username=not a user');
  assert.match(bad.body, /Pass \?username=/, 'invalid username must render an error card');

  const ok = await call('/api/pie?username=YuDavidCao&limit=4');
  require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'pr-pie.svg'), ok.body);
  assert.match(ok.headers['content-type'], /image\/svg/);
  assert.match(ok.body, /<\/svg>$/, 'must be a closed SVG');
  const arcs = ok.body.match(/<path|<circle/g) || [];
  assert.ok(arcs.length >= 2, `expected slices, got ${arcs.length}`);
  const pcts = [...ok.body.matchAll(/>([\d.]+)%</g)].map(m => +m[1]);
  const sum = pcts.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `slices must cover the pie, got ${sum}%`);
  inside(ok.body);
  // every slice in a big chart gets its own colour
  const big = await call('/api/pie?username=anuraghazra&range=all&limit=20');
  const fills = [...big.body.matchAll(/<(?:path|circle)[^>]*fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(fills.length >= 15, `expected a crowded pie, got ${fills.length} slices`);
  assert.strictEqual(new Set(fills).size, fills.length, 'two slices share a colour');
  inside(big.body);

  // a token must never pull private repo names into the repo breakdown
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || require('child_process').execSync('gh auth token').toString().trim();
  const tokened = await call('/api/pie?username=YuDavidCao&range=all&limit=10');
  assert.ok(!/minddoai/.test(tokened.body), 'private repo leaked into the card');

  // range: bad value errors, all-time >= default window, caption states the window
  const badRange = await call('/api/pie?username=anuraghazra&range=lastweek');
  assert.match(badRange.body, /range must look like/, 'bad range must render an error card');

  const defaulted = await call('/api/pie?username=anuraghazra');
  assert.match(defaulted.body, /last year<\/text>/, 'default caption must say last year');
  const allTime = await call('/api/pie?username=anuraghazra&range=all');
  const count = svg => +svg.match(/>(\d+) PRs ·/)[1];
  assert.ok(count(allTime.body) >= count(defaulted.body),
    `all-time (${count(allTime.body)}) must be >= last year (${count(defaulted.body)})`);
  console.log(`   range: ${count(defaulted.body)} PRs last year, ${count(allTime.body)} all time`);

  console.log(`ok — ${arcs.length} slices, ${sum.toFixed(1)}% total -> $TMPDIR/pr-pie.svg`);
})();

