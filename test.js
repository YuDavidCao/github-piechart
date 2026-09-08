// Runnable check: node test.js   (hits the live GitHub API, writes $TMPDIR/pr-pie.svg)
const assert = require('assert');
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN
  || require('child_process').execSync('gh auth token').toString().trim();
const handler = require('./api/pie.js');

const call = url => new Promise(done => {
  const headers = {};
  handler({ url }, { setHeader: (k, v) => (headers[k] = v), end: body => done({ headers, body }) });
});
const caption = svg => svg.match(/>(\d+) (\w+) ·/) || [];
const count = svg => +caption(svg)[1];

// every <text y> must sit inside the card
const inside = svg => {
  const h = +svg.match(/height="(\d+)"/)[1];
  for (const [, y] of svg.matchAll(/<text[^>]*\by="([\d.]+)"/g)) assert.ok(+y < h - 4, `text at y=${y} escapes height ${h}`);
};

(async () => {
  for (const [url, expected] of [
    ['/api/pie?username=not a user', /Pass \?username=/],
    ['/api/pie?username=octocat&by=merges', /by must be one of/],
    ['/api/pie?username=octocat&range=lastweek', /range must look like/],
  ]) assert.match((await call(url)).body, expected, `${url} should render an error card`);

  const pr = await call('/api/pie?username=YuDavidCao&limit=4');
  require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'pr-pie.svg'), pr.body);
  assert.match(pr.headers['content-type'], /image\/svg/);
  assert.match(pr.body, /<\/svg>$/, 'must be a closed SVG');
  assert.match(pr.body, /PRs · last year</, 'defaults to PRs over the last year');
  inside(pr.body);
  const pcts = [...pr.body.matchAll(/>([\d.]+)%</g)].map(m => +m[1]).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(pcts - 100) < 0.5, `slices must cover the pie, got ${pcts}%`);

  // by= picks a different metric; all is the sum of its parts
  const [commit, issue, review, all] = await Promise.all(['commit', 'issue', 'review', 'all']
    .map(by => call(`/api/pie?username=YuDavidCao&by=${by}`).then(r => r.body)));
  assert.match(commit, /commits · last year</);
  assert.strictEqual(count(all), count(pr.body) + count(commit) + count(issue) + (count(review) || 0),
    'all must equal pr + commit + issue + review');

  // a wider window can only find more
  const allTime = await call('/api/pie?username=YuDavidCao&range=all');
  assert.ok(count(allTime.body) >= count(pr.body), 'all time must be >= last year');

  // private repos must never reach a public card
  const tokened = await call('/api/pie?username=YuDavidCao&by=all&range=all&limit=20');
  assert.ok(!/minddoai/.test(tokened.body), 'private repo leaked into the card');

  // every slice of a crowded pie gets its own colour
  const big = await call('/api/pie?username=anuraghazra&by=all&range=all&limit=20');
  const fills = [...big.body.matchAll(/<(?:path|circle)[^>]*fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(fills.length >= 15, `expected a crowded pie, got ${fills.length} slices`);
  assert.strictEqual(new Set(fills).size, fills.length, 'two slices share a colour');
  inside(big.body);

  console.log(`ok — ${count(pr.body)} PRs / ${count(commit)} commits / ${count(all)} all, `
    + `${fills.length} distinct slices -> $TMPDIR/pr-pie.svg`);
})();
