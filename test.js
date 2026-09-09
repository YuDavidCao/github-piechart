// Deterministic regression suite: node test.js (no token or network required).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'api/pie.js'), 'utf8');
const kinds = {
  commit: ['commitContributionsByRepository', 'totalRepositoriesWithContributedCommits', 'totalCommitContributions'],
  pr: ['pullRequestContributionsByRepository', 'totalRepositoriesWithContributedPullRequests', 'totalPullRequestContributions'],
  issue: ['issueContributionsByRepository', 'totalRepositoriesWithContributedIssues', 'totalIssueContributions'],
  review: ['pullRequestReviewContributionsByRepository', 'totalRepositoriesWithContributedPullRequestReviews', 'totalPullRequestReviewContributions'],
};
const captionCount = svg => Number((svg.match(/>(\d+) \w+ ·/) || [])[1]);
const event = (date, repo = 'public/repo', kind = 'pr', count = 1, isPrivate = false) =>
  ({ date, repo, kind, count, isPrivate });

function harness({ now = '2026-09-09T12:00:00Z', createdAt = '2020-01-01T00:00:00Z',
  events = [], restricted = [], delay = 0, respond, token = 'fixture-token', timeout = 8000,
  deadline = 25000 } = {}) {
  const requests = [];
  let active = 0, peak = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = {
    module: { exports: {} }, URL, Date: FixedDate, AbortController,
    AbortSignal: { any: AbortSignal.any, timeout: () => AbortSignal.timeout(timeout) },
    setTimeout: fn => setTimeout(fn, deadline), clearTimeout,
    process: { env: token ? { GITHUB_TOKEN: token } : {} },
    fetch: async (_url, options) => {
      const request = { ...JSON.parse(options.body), signal: options.signal };
      requests.push(request);
      peak = Math.max(peak, ++active);
      try {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (respond) {
          const result = await respond(request);
          if (result) return result;
        }
        if (!request.variables.from) return response({ user: createdAt ? { createdAt } : null });
        const { from, to } = request.variables;
        // GitHub's public counts include both endpoint calendar dates.
        const inRange = value => value.date >= from.slice(0, 10) && value.date <= to.slice(0, 10);
        const collection = {};
        for (const [kind, [field, repoTotal, contributionTotal]] of Object.entries(kinds)) {
          const repos = new Map();
          for (const value of events.filter(value => value.kind === kind && inRange(value))) {
            const previous = repos.get(value.repo);
            repos.set(value.repo, {
              repository: { nameWithOwner: value.repo, isPrivate: value.isPrivate },
              contributions: { totalCount: (previous?.contributions.totalCount || 0) + value.count },
            });
          }
          collection[field] = [...repos.values()].slice(0, 100);
          collection[repoTotal] = repos.size;
          collection[contributionTotal] = [...repos.values()].reduce((sum, row) => sum + row.contributions.totalCount, 0);
        }
        if (request.query.includes('restrictedContributionsCount')) {
          collection.restrictedContributionsCount = restricted.filter(inRange).reduce((sum, value) => sum + value.count, 0);
        }
        return response({ user: { contributionsCollection: collection } });
      } finally {
        active--;
      }
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    requests,
    get peak() { return peak; },
    async call(query = '') {
      const params = new URLSearchParams({ username: 'fixture' });
      new URLSearchParams(query).forEach((value, key) => params.set(key, value));
      const headers = {};
      let body;
      await context.module.exports({ url: `/api/pie?${params}` }, {
        setHeader: (key, value) => { headers[key] = value; },
        end: value => { body = value; },
      });
      assert.equal(typeof body, 'string', 'handler must finish the response');
      return { headers, body };
    },
  };
}

function response(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

test('calendar windows count each boundary date once', async () => {
  const app = harness({
    createdAt: '2025-09-10T08:00:00Z',
    events: [event('2026-09-08', 'public/a', 'pr', 14), event('2026-09-09', 'public/b', 'pr', 2)],
  });
  const { body } = await app.call('range=all');
  assert.equal(captionCount(body), 16);
  const windows = app.requests.filter(request => request.variables.from);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].variables.to, '2026-09-08T23:59:59.999Z');
  assert.equal(windows[1].variables.from, '2026-09-09T00:00:00.000Z');
});

test('month and year subtraction clamp to the target month', async () => {
  for (const [now, range, expected] of [
    ['2026-03-31T12:00:00Z', '1m', '2026-02-28'],
    ['2024-03-31T12:00:00Z', '1m', '2024-02-29'],
    ['2024-02-29T12:00:00Z', '1y', '2023-02-28'],
    ['2026-08-31T12:00:00Z', '6m', '2026-02-28'],
  ]) {
    const app = harness({ now });
    await app.call(`range=${range}`);
    assert.equal(app.requests[1].variables.from, `${expected}T00:00:00.000Z`);
  }
});

test('large ranges stop at account creation and use bounded concurrency', async () => {
  const app = harness({ createdAt: '2020-01-01T18:00:00Z', delay: 2, events: [event('2026-09-01')] });
  const { body } = await app.call('range=999y');
  assert.equal(captionCount(body), 1);
  assert.ok(app.requests.length < 10);
  assert.ok(app.peak > 1 && app.peak <= 4);
  assert.equal(app.requests[1].variables.from, '2020-01-01T00:00:00.000Z');
});

test('the default year uses one account lookup and two calendar windows', async () => {
  const app = harness();
  await app.call();
  assert.equal(app.requests.length, 3);
});

test('truncated kinds are recovered without repeating complete kinds or private totals', async () => {
  const events = Array.from({ length: 150 }, (_, i) => event(i < 75 ? '2026-08-20' : '2026-09-05', `public/repo-${i}`, 'commit', 2));
  events.push(event('2026-08-20', 'public/pr', 'pr', 3), event('2026-09-05', 'public/pr', 'pr', 4));
  events.push(event('2026-08-20', 'confidential/recovered', 'commit', 7, true));
  const app = harness({ events, restricted: [{ date: '2026-08-20', count: 5 }, { date: '2026-09-05', count: 8 }] });
  const { body } = await app.call('range=30d&by=all&private=true&limit=20');
  assert.equal(captionCount(body), 320);
  assert.match(body, />private repos</);
  assert.match(body, />131 more repos</);
  assert.ok(!body.includes('confidential'));
  assert.equal(app.requests.length, 4);
  for (const request of app.requests.slice(2)) {
    assert.ok(request.query.includes(kinds.commit[0]));
    assert.ok(!request.query.includes(kinds.pr[0]));
    assert.ok(!request.query.includes('restrictedContributionsCount'));
  }
});

test('exactly 100 repositories fit without extra recovery queries', async () => {
  const app = harness({ events: Array.from({ length: 100 }, (_, i) => event('2026-09-09', `public/repo-${i}`)) });
  const { body } = await app.call('range=1d');
  assert.equal(captionCount(body), 100);
  assert.equal(app.requests.length, 2);
});

test('truncation within a single day returns an error instead of partial percentages', async () => {
  const app = harness({ events: Array.from({ length: 101 }, (_, i) => event('2026-09-09', `public/repo-${i}`)) });
  const { body, headers } = await app.call('range=1d');
  assert.match(body, /Too many repos in one day/);
  assert.ok(!Number.isFinite(captionCount(body)));
  assert.equal(headers['cache-control'], 'public, max-age=60');
});

test('non-additive split totals cannot become a misleading chart', async () => {
  const app = harness({
    events: Array.from({ length: 150 }, (_, i) => event(i < 75 ? '2026-08-20' : '2026-09-05', `public/repo-${i}`, 'review')),
    respond: request => {
      if (request.variables.from === '2026-08-10T00:00:00.000Z' && request.variables.to === '2026-09-09T12:00:00.000Z') {
        return response({ user: { contributionsCollection: {
          [kinds.review[0]]: [], [kinds.review[1]]: 150, [kinds.review[2]]: 149,
        } } });
      }
    },
  });
  const { body } = await app.call('range=30d&by=review');
  assert.match(body, /GitHub totals differ/);
  assert.ok(!Number.isFinite(captionCount(body)));
});

test('adaptive queries stop at the per-card request budget', async () => {
  const app = harness({
    respond: request => {
      if (request.variables.from) return response({ user: { contributionsCollection: {
        [kinds.pr[0]]: [], [kinds.pr[1]]: 101, [kinds.pr[2]]: 101,
      } } });
    },
  });
  const { body } = await app.call('range=999y&by=pr');
  assert.match(body, /Too much activity to fetch completely/);
  assert.ok(app.requests.length <= 64);
});

function stalledResponse({ signal }) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('a stalled GitHub request renders a timeout error', async () => {
  const app = harness({ timeout: 5, deadline: 1000, respond: stalledResponse });
  const { body } = await app.call();
  assert.match(body, /GitHub request timed out/);
  assert.ok(app.requests[0].signal.aborted);
});

test('the overall deadline also aborts slow responses', async () => {
  const app = harness({ timeout: 1000, deadline: 5, respond: stalledResponse });
  const { body } = await app.call();
  assert.match(body, /GitHub request timed out/);
});

test('the request timeout covers a stalled response body', async () => {
  const app = harness({ timeout: 5, deadline: 1000,
    respond: request => ({ ok: true, status: 200, json: () => stalledResponse(request) }),
  });
  assert.match((await app.call()).body, /GitHub request timed out/);
});

test('an upstream failure aborts other active requests and drains queued work', async () => {
  const app = harness({ respond: request => {
    if (!request.variables.from) return;
    if (request.variables.from.startsWith('2020-01-01')) throw new Error('fixture transport failure');
    return stalledResponse(request);
  } });
  assert.match((await app.call('range=all')).body, /fixture transport failure/);
  const countAtCompletion = app.requests.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.length, countAtCompletion);
  assert.ok(app.requests.every(request => request.signal.aborted));
  assert.ok(app.peak <= 4);
});

test('prototype properties are not valid modes or themes', async () => {
  for (const by of ['constructor', '__proto__']) {
    const app = harness();
    assert.match((await app.call(`by=${by}`)).body, /by must be one of/);
    assert.equal(app.requests.length, 0);
  }
  for (const theme of ['constructor', '__proto__', 'toString']) {
    const app = harness({ events: [event('2026-09-01')] });
    const { body } = await app.call(`theme=${theme}`);
    assert.equal(captionCount(body), 1);
    assert.match(body, /fill="#ffffff"/);
    assert.ok(!body.includes('undefined'));
  }
});

test('SVG text removes invalid XML characters while preserving emoji and escaping markup', async () => {
  const app = harness({ events: [event('2026-09-01')] });
  const title = 'hello\0\u0001\u000b\uFFFEworld 🚀 <b>&"';
  const { body } = await app.call(`title=${encodeURIComponent(title)}`);
  assert.equal(captionCount(body), 1);
  assert.match(body, /helloworld 🚀 &lt;b&gt;&amp;&quot;/);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(body));
});

test('private repository names are excluded in every mode on successful charts', async () => {
  const events = Object.keys(kinds).flatMap(kind => [
    event('2026-09-01', `public/${kind}`, kind, 3),
    event('2026-09-01', `confidential/${kind}-alpha`, kind, 7, true),
    event('2026-09-02', `another-private/${kind}-beta`, kind, 11, true),
  ]);
  for (const by of [...Object.keys(kinds), 'all']) {
    const app = harness({ events });
    const { body } = await app.call(`by=${by}`);
    assert.equal(captionCount(body), by === 'all' ? 12 : 3);
    assert.ok(!body.includes('confidential') && !body.includes('another-private'));
    assert.match(body, /public\//);
  }
});

test('validation, missing users, empty activity and upstream failures render errors', async () => {
  for (const [query, expected] of [['username=not+a+user', /Pass \?username=/], ['by=merges', /by must/],
    ['range=0m', /range must/], ['range=lastweek', /range must/], ['private=true&by=pr', /needs by=all/]]) {
    const app = harness();
    assert.match((await app.call(query)).body, expected);
    assert.equal(app.requests.length, 0);
  }
  assert.match((await harness({ token: '' }).call()).body, /missing GITHUB_TOKEN/);
  assert.match((await harness({ createdAt: null }).call()).body, /No such user/);
  assert.match((await harness().call()).body, /No public contributions/);
  for (const status of [401, 403, 429, 500]) {
    const app = harness({ respond: () => ({ ok: false, status }) });
    assert.match((await app.call()).body, status === 401 ? /TOKEN rejected/ : new RegExp(`GraphQL ${status}`));
  }
  const app = harness({ respond: () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'fixture failure' }] }) }) });
  assert.match((await app.call()).body, /fixture failure/);
});

test('changing snippet format keeps the last rendered username and URL together', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const elements = {};
  for (const id of ['user', 'by', 'range', 'limit', 'theme', 'private', 'f', 'slot', 'status', 'snip', 'snippet', 'copy']) {
    elements[id] = { value: '', checked: false, hidden: true, textContent: '', classList: { add() {}, remove() {} },
      replaceChildren(child) { child.parentNode = this; } };
  }
  Object.assign(elements.by, { value: 'all' });
  Object.assign(elements.range, { value: '1y' });
  Object.assign(elements.limit, { value: '6' });
  Object.assign(elements.theme, { value: 'light' });
  const tabs = ['md', 'html'].map(fmt => ({ dataset: { fmt }, setAttribute() {} }));
  const context = {
    document: { getElementById: id => elements[id], querySelectorAll: () => tabs },
    Image: class {}, URLSearchParams, location: { origin: 'https://example.test', search: '' },
    history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout,
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  assert.equal(elements.snippet.hidden, true);
  elements.user.value = 'octocat';
  elements.f.onsubmit({ preventDefault() {} });
  assert.equal(elements.snippet.hidden, false);
  for (const edited of ['someone-else', 'invalid user <text>']) {
    elements.user.value = edited;
    tabs[1].onclick();
    assert.match(elements.snip.textContent, /href="https:\/\/example\.test\/\?user=octocat&by=all&range=1y&limit=6&theme=light"/);
    assert.match(elements.snip.textContent, /username=octocat&/);
    assert.ok(!elements.snip.textContent.includes(edited));
    tabs[0].onclick();
    assert.ok(elements.snip.textContent.endsWith('](https://example.test/?user=octocat&by=all&range=1y&limit=6&theme=light)'));
  }
});
