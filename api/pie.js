// GET /api/pie?username=octocat[&limit=6][&theme=dark][&range=1y][&title=...] -> SVG pie of PRs per repo.
const COLORS = ['#7c4dff','#e53935','#1e88e5','#43a047','#fb8c00','#00acc1','#d81b60','#8d6e63','#546e7a','#c0ca33'];
const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', dim: '#656d76' },
  dark:  { bg: '#0d1117', border: '#30363d', text: '#e6edf3', dim: '#8b949e' },
};
const W = 480, R = 70, CX = 110, CY = 135, LEGEND_X = 215, ROW_H = 24, MAX_PAGES = 5;

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

const auth = () => (process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {});

async function search(user, page, since) {
  // is:public is load-bearing: with GITHUB_TOKEN set, search would otherwise return PRs from
  // private repos the token can see, leaking their names into a public card.
  const q = `type:pr author:${user} is:public` + (since ? ` created:>=${since.toISOString().slice(0, 10)}` : '');
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'pr-pie',
      ...auth(),
    },
  });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub rate limit hit' : `GitHub API ${res.status}`);
  return res.json();
}

async function prsByRepo(user, since) {
  const first = await search(user, 1, since);
  // ponytail: 500 PR ceiling (5 parallel pages). Raise MAX_PAGES if someone real hits it; GitHub search caps at 1000 anyway.
  const pages = Math.min(Math.ceil(first.total_count / 100), MAX_PAGES);
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => search(user, i + 2, since)));
  const counts = new Map();
  for (const { items } of [first, ...rest]) {
    for (const it of items) {
      const repo = it.repository_url.split('/').slice(-2).join('/');
      counts.set(repo, (counts.get(repo) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function slice(from, to, color) {
  if (to - from >= 1) return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${color}"/>`;
  const pt = f => {
    const a = 2 * Math.PI * f - Math.PI / 2;
    return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY + R * Math.sin(a)).toFixed(2)}`;
  };
  return `<path d="M ${CX} ${CY} L ${pt(from)} A ${R} ${R} 0 ${to - from > 0.5 ? 1 : 0} 1 ${pt(to)} Z" fill="${color}"/>`;
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
  let at = 0;
  const color = (row, i) => row[2] || COLORS[i % COLORS.length];
  const slices = rows.map((row, i) => {
    const from = at;
    at += row[1] / total;
    return slice(from, at, color(row, i));
  }).join('\n');
  const legend = rows.map((row, i) => {
    const [repo, n] = row;
    const y = 70 + i * ROW_H;
    return `<rect x="${LEGEND_X}" y="${y - 10}" width="12" height="12" rx="2" fill="${color(row, i)}"/>
<text x="${LEGEND_X + 20}" y="${y}" font-size="12" fill="${t.text}">${esc(clip(repo, 22))}</text>
<text x="${W - 20}" y="${y}" font-size="12" text-anchor="end" fill="${t.dim}">${(n / total * 100).toFixed(1)}%</text>`;
  }).join('\n');
  const height = Math.max(240, 70 + rows.length * ROW_H + 20);
  return card(`<text x="20" y="34" font-size="15" font-weight="600" fill="${t.text}">${esc(title)}</text>
${slices}
<text x="${CX}" y="${CY + R + 20}" font-size="11" text-anchor="middle" fill="${t.dim}">${esc(caption)}</text>
${legend}`, height, t);
}

module.exports = async (req, res) => {
  const { searchParams } = new URL(req.url, 'http://x');
  const user = (searchParams.get('username') || searchParams.get('user') || '').trim();
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit'), 10) || 6, 1), 10);
  const t = THEMES[searchParams.get('theme')] || THEMES.light;
  const range = parseRange(searchParams.get('range'));
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) {
    res.setHeader('cache-control', 'no-cache');
    return res.status(200).send(errorCard('Pass ?username=<github-user>', t));
  }
  if (!range) {
    res.setHeader('cache-control', 'no-cache');
    return res.status(200).send(errorCard('range must look like 30d, 6m, 2y or all', t));
  }
  try {
    const all = await prsByRepo(user, range.since);
    if (!all.length) throw new Error(`No public PRs for ${user} in the ${range.label}`);
    const total = all.reduce((s, [, n]) => s + n, 0);
    const top = all.slice(0, limit);
    const rest = all.slice(limit);
    if (rest.length) top.push([`${rest.length} more repos`, rest.reduce((s, [, n]) => s + n, 0), t.dim]);
    const caption = `${total} PRs · ${range.label}`;
    res.setHeader('cache-control', 'public, max-age=7200, s-maxage=7200');
    res.status(200).send(chart(top, total, caption, searchParams.get('title') || `${user}'s PRs by repo`, t));
  } catch (e) {
    res.setHeader('cache-control', 'public, max-age=60');
    res.status(200).send(errorCard(e.message, t));
  }
};
