// GET /api/pie?username=octocat[&limit=6][&theme=dark][&range=1y][&title=...] -> SVG pie of PRs per repo.
// Golden-angle hue rotation: any number of slices, adjacent ones always far apart in hue.
// Lightness alternates so colours that eventually wrap near the same hue still separate.
const sliceColor = i => `hsl(${((200 + i * 137.508) % 360).toFixed(1)}, 68%, ${i % 2 ? 45 : 58}%)`;
const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', dim: '#656d76' },
  dark:  { bg: '#0d1117', border: '#30363d', text: '#e6edf3', dim: '#8b949e' },
};
const KINDS = {
  commit: 'commitContributionsByRepository',
  pr: 'pullRequestContributionsByRepository',
  issue: 'issueContributionsByRepository',
  review: 'pullRequestReviewContributionsByRepository',
};
const MODES = {
  pr: { kinds: ['pr'], label: 'PRs' },
  commit: { kinds: ['commit'], label: 'commits' },
  issue: { kinds: ['issue'], label: 'issues' },
  review: { kinds: ['review'], label: 'reviews' },
  all: { kinds: ['commit', 'pr', 'issue', 'review'], label: 'contributions' },
};
const W = 480, R = 70, CX = 110, CY = 135, LEGEND_X = 215, ROW_H = 24;

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const DAY = 86400000;

// range=1y (default) | 6m | 90d | all
function parseRange(raw) {
  const v = (raw || '1y').toLowerCase();
  if (v === 'all') return { since: null, label: 'all time' };
  const m = /^(\d{1,3})([dmy])$/.exec(v);
  if (!m || !+m[1]) return null;
  const n = +m[1], since = new Date();
  if (m[2] === 'd') since.setUTCDate(since.getUTCDate() - n);
  if (m[2] === 'm') since.setUTCMonth(since.getUTCMonth() - n);
  if (m[2] === 'y') since.setUTCFullYear(since.getUTCFullYear() - n);
  const unit = { d: 'day', m: 'month', y: 'year' }[m[2]];
  return { since, label: `last ${n === 1 ? unit : `${n} ${unit}s`}` };
}

const auth = () => ({ authorization: `Bearer ${process.env.GITHUB_TOKEN}` });

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'pr-pie', ...auth() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new Error('GITHUB_TOKEN rejected by GitHub');
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const { data, errors } = await res.json();
  if (errors && errors.length) throw new Error(errors[0].message);
  return data;
}

// contributionsCollection accepts at most a 1-year window, so walk the range in 364-day chunks.
function windows(from) {
  const now = new Date(), out = [];
  for (let start = from; start < now; ) {
    const end = new Date(Math.min(start.getTime() + 364 * DAY, now.getTime()));
    out.push([start.toISOString(), end.toISOString()]);
    start = new Date(end.getTime() + 1);
  }
  return out;
}

async function contributionsByRepo(user, since, kinds) {
  let from = since;
  if (!from) {
    const { user: u } = await gql('query($login:String!){ user(login:$login){ createdAt } }', { login: user });
    if (!u) throw new Error(`No such user: ${user}`);
    from = new Date(u.createdAt);
  }
  const fields = kinds.map(k =>
    `${KINDS[k]}(maxRepositories:100){ repository{ nameWithOwner isPrivate } contributions{ totalCount } }`).join(' ');
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){ contributionsCollection(from:$from,to:$to){ ${fields} } } }`;

  // One request per window, in parallel: all-time on an old account is ~9 windows and each
  // costs a single rate-limit point, but serialising them runs into the function timeout.
  const results = await Promise.all(windows(from).map(([f, t]) =>
    gql(query, { login: user, from: f, to: t })));

  const counts = new Map();
  for (const r of results) {
    if (!r.user) throw new Error(`No such user: ${user}`);
    for (const k of kinds) {
      for (const node of r.user.contributionsCollection[KINDS[k]]) {
        if (node.repository.isPrivate) continue; // never name a private repo on a public card
        const name = node.repository.nameWithOwner;
        counts.set(name, (counts.get(name) || 0) + node.contributions.totalCount);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
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
  return card(`<text x="20" y="40" font-size="15" font-weight="600" fill="${t.text}">PRs by repo</text>
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
  const t = THEMES[searchParams.get('theme')] || THEMES.light;
  const range = parseRange(searchParams.get('range'));
  const mode = MODES[(searchParams.get('by') || 'pr').toLowerCase()];
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard('Pass ?username=<github-user>', t));
  }
  if (!mode) {
    res.setHeader('cache-control', 'no-cache');
    return res.end(errorCard(`by must be one of ${Object.keys(MODES).join(', ')}`, t));
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
    const all = await contributionsByRepo(user, range.since, mode.kinds);
    if (!all.length) throw new Error(`No public ${mode.label} for ${user} in the ${range.label}`);
    const total = all.reduce((s, [, n]) => s + n, 0);
    const top = all.slice(0, limit);
    const rest = all.slice(limit);
    if (rest.length) top.push([`${rest.length} more repos`, rest.reduce((s, [, n]) => s + n, 0), t.dim]);
    const caption = `${total} ${mode.label} · ${range.label}`;
    res.setHeader('cache-control', 'public, max-age=7200, s-maxage=7200');
    res.end(chart(top, total, caption, searchParams.get('title') || `${user}'s ${mode.label} by repo`, t));
  } catch (e) {
    res.setHeader('cache-control', 'public, max-age=60');
    res.end(errorCard(e.message, t));
  }
};
