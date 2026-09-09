// GET /api/pie?username=octocat[&limit=6][&theme=dark][&range=1y][&title=...] -> SVG pie of contributions per repo.
// Golden-angle hue rotation: any number of slices, adjacent ones always far apart in hue.
// Lightness alternates so colours that eventually wrap near the same hue still separate.
const sliceColor = i => `hsl(${((200 + i * 137.508) % 360).toFixed(1)}, 68%, ${i % 2 ? 45 : 58}%)`;
const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', dim: '#656d76' },
  dark:  { bg: '#0d1117', border: '#30363d', text: '#e6edf3', dim: '#8b949e' },
};
const PRIVATE_COLOR = '#546e7a';
const KINDS = {
  commit: 'commitContributionsByRepository',
  pr: 'pullRequestContributionsByRepository',
  issue: 'issueContributionsByRepository',
  review: 'pullRequestReviewContributionsByRepository',
};
const REPO_TOTALS = {
  commit: 'totalRepositoriesWithContributedCommits',
  pr: 'totalRepositoriesWithContributedPullRequests',
  issue: 'totalRepositoriesWithContributedIssues',
  review: 'totalRepositoriesWithContributedPullRequestReviews',
};
const CONTRIBUTION_TOTALS = {
  commit: 'totalCommitContributions',
  pr: 'totalPullRequestContributions',
  issue: 'totalIssueContributions',
  review: 'totalPullRequestReviewContributions',
};
const MODES = {
  pr: { kinds: ['pr'], label: 'PRs' },
  commit: { kinds: ['commit'], label: 'commits' },
  issue: { kinds: ['issue'], label: 'issues' },
  review: { kinds: ['review'], label: 'reviews' },
  all: { kinds: ['commit', 'pr', 'issue', 'review'], label: 'contributions' },
};
const W = 480, R = 70, CX = 110, CY = 135, LEGEND_X = 215, ROW_H = 24;

// XML 1.0 forbids control characters and unpaired surrogates, even inside text nodes.
const esc = s => String(s)
  .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const DAY = 86400000;
const MAX_REQUESTS = 64, CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 8000, TOTAL_TIMEOUT_MS = 25000;

function startOfDay(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function subtractMonths(date, months) {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

// range=1y (default) | 6m | 90d | all
function parseRange(raw) {
  const v = (raw || '1y').toLowerCase();
  if (v === 'all') return { since: null, label: 'all time' };
  const m = /^(\d{1,3})([dmy])$/.exec(v);
  if (!m || !+m[1]) return null;
  const n = +m[1], since = startOfDay(new Date());
  if (m[2] === 'd') since.setUTCDate(since.getUTCDate() - n);
  if (m[2] === 'm') subtractMonths(since, n);
  if (m[2] === 'y') subtractMonths(since, n * 12);
  const unit = { d: 'day', m: 'month', y: 'year' }[m[2]];
  return { since, label: `last ${n === 1 ? unit : `${n} ${unit}s`}` };
}

const auth = () => ({ authorization: `Bearer ${process.env.GITHUB_TOKEN}` });

async function gql(query, variables, signal) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'pr-pie', ...auth() },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (res.status === 401) throw new Error('GITHUB_TOKEN rejected by GitHub');
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const { data, errors } = await res.json();
  if (errors && errors.length) throw new Error(errors[0].message);
  return data;
}

function githubClient() {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('GitHub request timed out; try a shorter range')), TOTAL_TIMEOUT_MS);
  const waiting = [];
  let requests = 0, active = 0;
  return {
    async query(query, variables) {
      if (requests >= MAX_REQUESTS) throw new Error('Too much activity to fetch completely; try a shorter range');
      requests++;
      if (active < CONCURRENCY) active++;
      else await new Promise(resolve => waiting.push(resolve));
      try {
        controller.signal.throwIfAborted();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        try {
          return await gql(query, variables, signal);
        } catch (error) {
          if (signal.aborted) throw new Error('GitHub request timed out; try a shorter range');
          throw error;
        }
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
    close() {
      clearTimeout(deadline);
      controller.abort();
    },
  };
}

// GitHub includes whole calendar days for public contributions. Never share a date
// between windows; 364 calendar days also stays below its one-year query limit.
function windows(from, now) {
  const out = [];
  for (let start = startOfDay(from); start <= now; ) {
    const next = new Date(start.getTime() + 364 * DAY);
    const end = new Date(Math.min(next.getTime() - 1, now.getTime()));
    out.push([start, end]);
    start = next;
  }
  return out;
}

async function contributionsByRepo(user, since, kinds, wantPrivate) {
  const client = githubClient(), now = new Date();
  const counts = new Map();
  let restricted = 0;

  async function collect(from, to, selectedKinds, includePrivate) {
    const fields = selectedKinds.map(k =>
      `${REPO_TOTALS[k]} ${CONTRIBUTION_TOTALS[k]}
       ${KINDS[k]}(maxRepositories:100){ repository{ nameWithOwner isPrivate } contributions{ totalCount } }`)
      .concat(includePrivate ? ['restrictedContributionsCount'] : []).join(' ');
    const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){ contributionsCollection(from:$from,to:$to){ ${fields} } } }`;
    const r = await client.query(query, { login: user, from: from.toISOString(), to: to.toISOString() });
    if (!r.user) throw new Error(`No such user: ${user}`);
    const c = r.user.contributionsCollection;
    if (includePrivate) restricted += c.restrictedContributionsCount || 0;
    const incomplete = [], totals = {};
    for (const k of selectedKinds) {
      if (c[KINDS[k]].length < c[REPO_TOTALS[k]]) {
        incomplete.push(k);
        continue;
      }
      totals[k] = 0;
      for (const node of c[KINDS[k]]) {
        totals[k] += node.contributions.totalCount;
        if (node.repository.isPrivate) continue; // never name a private repo on a public card
        const name = node.repository.nameWithOwner;
        counts.set(name, (counts.get(name) || 0) + node.contributions.totalCount);
      }
    }
    if (incomplete.length) {
      const days = Math.round((startOfDay(to) - from) / DAY) + 1;
      if (days <= 1) throw new Error('Too many repos in one day for a complete chart');
      const middle = new Date(from.getTime() + Math.floor(days / 2) * DAY);
      // Only retry truncated kinds. Complete kinds and private totals were already counted.
      const halves = await Promise.all([
        collect(from, new Date(middle.getTime() - 1), incomplete, false),
        collect(middle, to, incomplete, false),
      ]);
      for (const k of incomplete) {
        totals[k] = halves[0][k] + halves[1][k];
        // Some contribution types (e.g. repeated reviews of one PR) are not additive.
        if (totals[k] !== c[CONTRIBUTION_TOTALS[k]]) {
          throw new Error('GitHub totals differ across date ranges; try a shorter range');
        }
      }
    }
    return totals;
  }

  try {
    const { user: u } = await client.query('query($login:String!){ user(login:$login){ createdAt } }', { login: user });
    if (!u) throw new Error(`No such user: ${user}`);
    const createdAt = new Date(u.createdAt);
    const from = since && since > createdAt ? since : createdAt;
    await Promise.all(windows(from, now).map(([f, t]) => collect(f, t, kinds, wantPrivate)));
    return { rows: [...counts].sort((a, b) => b[1] - a[1]), restricted };
  } finally {
    client.close();
  }
}

function slice(from, to, color, cy) {
  if (to - from >= 1) return `<circle cx="${CX}" cy="${cy}" r="${R}" fill="${color}"/>`;
  const pt = f => {
    const a = 2 * Math.PI * f - Math.PI / 2;
    return `${(CX + R * Math.cos(a)).toFixed(2)} ${(cy + R * Math.sin(a)).toFixed(2)}`;
  };
  return `<path d="M ${CX} ${cy} L ${pt(from)} A ${R} ${R} 0 ${to - from > 0.5 ? 1 : 0} 1 ${pt(to)} Z" fill="${color}"/>`;
}

function card(body, height, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="6" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>`;
}

function errorCard(msg, t) {
  return card(`<text x="20" y="40" font-size="15" font-weight="600" fill="${t.text}">Contributions by repo</text>
<text x="20" y="66" font-size="13" fill="${t.dim}">${esc(msg)}</text>`, 90, t);
}

function chart(rows, total, caption, title, t) {
  const height = Math.max(240, 70 + rows.length * ROW_H + 20);
  const cy = Math.max(CY, height / 2 - 10); // keep the pie beside the legend, not stranded at the top
  let at = 0;
  const color = (row, i) => row[2] || sliceColor(i);
  const slices = rows.map((row, i) => {
    const from = at;
    at += row[1] / total;
    return slice(from, at, color(row, i), cy);
  }).join('\n');
  const legend = rows.map((row, i) => {
    const [repo, n] = row;
    const y = 70 + i * ROW_H;
    return `<rect x="${LEGEND_X}" y="${y - 10}" width="12" height="12" rx="2" fill="${color(row, i)}"/>
<text x="${LEGEND_X + 20}" y="${y}" font-size="12" fill="${t.text}">${esc(clip(repo, 22))}</text>
<text x="${W - 20}" y="${y}" font-size="12" text-anchor="end" fill="${t.dim}">${(n / total * 100).toFixed(1)}%</text>`;
  }).join('\n');
  return card(`<text x="20" y="34" font-size="15" font-weight="600" fill="${t.text}">${esc(title)}</text>
${slices}
<text x="${CX}" y="${cy + R + 20}" font-size="11" text-anchor="middle" fill="${t.dim}">${esc(caption)}</text>
${legend}`, height, t);
}

module.exports = async (req, res) => {
  const { searchParams } = new URL(req.url, 'http://x');
  const user = (searchParams.get('username') || searchParams.get('user') || '').trim();
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit'), 10) || 6, 1), 20);
  const theme = searchParams.get('theme');
  const t = Object.hasOwn(THEMES, theme) ? THEMES[theme] : THEMES.light;
  const range = parseRange(searchParams.get('range'));
  const by = (searchParams.get('by') || 'all').toLowerCase();
  const mode = Object.hasOwn(MODES, by) ? MODES[by] : null;
  const wantPrivate = /^(1|true|yes)$/i.test(searchParams.get('private') || '');
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard('Pass ?username=<github-user>', t));
  }
  if (!mode) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard(`by must be one of ${Object.keys(MODES).join(', ')}`, t));
  }
  if (wantPrivate && mode !== MODES.all) {
    res.setHeader('cache-control', 'no-cache');
    // GitHub lumps every private contribution type into one number, so it only lines up with by=all.
    return res.end(errorCard('private=true needs by=all', t));
  }
  if (!process.env.GITHUB_TOKEN) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard('This deploy is missing GITHUB_TOKEN', t));
  }
  if (!range) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard('range must look like 30d, 6m, 2y or all', t));
  }
  try {
    const { rows, restricted } = await contributionsByRepo(user, range.since, mode.kinds, wantPrivate);
    if (!rows.length && !restricted) throw new Error(`No public ${mode.label} for ${user} in the ${range.label}`);
    const total = rows.reduce((s, [, n]) => s + n, 0) + restricted;
    const top = rows.slice(0, limit);
    const rest = rows.slice(limit);
    if (rest.length) top.push([`${rest.length} more repos`, rest.reduce((s, [, n]) => s + n, 0), t.dim]);
    if (restricted) top.push(['private repos', restricted, PRIVATE_COLOR]);
    const caption = `${total} ${mode.label} · ${range.label}`;
    res.setHeader('cache-control', 'public, max-age=7200, s-maxage=7200');
    res.end(chart(top, total, caption, searchParams.get('title') || `${user}'s ${mode.label} by repo`, t));
  } catch (e) {
    res.setHeader('cache-control', 'public, max-age=60');
    res.end(errorCard(e.message, t));
  }
};
