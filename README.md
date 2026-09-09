# PR Pie

A pie chart of anyone's GitHub contributions, grouped by repo, as an SVG you can embed in a
README. No build step, no dependencies, one serverless function.

<p align="center">
  <img src="https://github-piechart.vercel.app/api/pie?username=YuDavidCao&range=1y" alt="Example card: PRs by repo">
</p>

```markdown
[![PRs by repo](https://github-piechart.vercel.app/api/pie?username=octocat&range=1y)](https://github-piechart.vercel.app/?user=octocat&by=pr&range=1y&limit=6&theme=light)
```

Point it at your own deployment rather than the demo above — see [Deploy your own](#deploy-your-own).
[Live configurator](https://github-piechart.vercel.app) builds the snippet for you.

## Options

| Param | Default | Notes |
|---|---|---|
| `username` | — | required |
| `by` | `pr` | what to count: `pr`, `commit`, `issue`, `review`, `all` |
| `range` | `1y` | window to count over: `30d`, `6m`, `2y`, `all` |
| `limit` | `6` | top N repos, 1–20; the rest collapse into one "N more repos" slice |
| `theme` | `light` | `light` or `dark` |
| `private` | `false` | adds one lump slice for private-repo work; requires `by=all` |
| `title` | `<user>'s <metric> by repo` | override the heading |

The caption always states what was counted and over what window, so a card can't quietly
misrepresent itself: `156 commits · last year`.

### Counting private work

GitHub exposes private activity as a single `restrictedContributionsCount` — no repo names, no
per-type split — and it reads 0 unless that user has ticked **Include private contributions on
my profile** in their GitHub settings.

Because the number mixes commits, PRs, issues and reviews, it only lines up with `by=all`; any
other mode returns an error card instead of putting non-PRs into a PR pie. Expect the slice to
dominate, since private commits usually outnumber public contributions many times over.

## Privacy

Cards are built with the *deployment's* token, not the visitor's. GitHub's search API would
happily return results from private repos that token can see, so this project never uses it:
counts come from `contributionsCollection`, whose per-repo breakdowns exclude private repos,
and any private repo appearing there is dropped anyway. A private repo name cannot reach a
public card. There is a test asserting exactly that.

## How it works

`api/pie.js` is a single serverless function. It queries GitHub's GraphQL API for per-repo
contribution totals, then writes SVG arcs by hand — no chart library, no runtime dependencies.

- **Complete counts.** Ranges use distinct UTC calendar dates, in windows of at most 364 days.
  The start date is clamped to account creation; month and year subtraction preserves the day
  where possible and otherwise uses the target month's last day. GitHub returns at most 100
  repos per contribution type per window. When its repository totals show missing results,
  the function splits that window and refetches only the affected contribution types. It
  checks recovered totals before rendering, and counts private totals only once per original
  window. If even one day exceeds the repository cap, or split totals disagree, it renders an
  error instead of incomplete percentages.
- **Bounded requests.** Each card uses one account lookup plus its contribution queries. For
  an account older than a year, `range=1y` normally uses **3 requests**: one lookup and two
  windows. Truncation recovery adds requests. At most 4 requests run concurrently, with a
  maximum of 64 requests per card, an 8-second timeout per request, and a 25-second overall
  deadline. Exceeding these limits produces an error card; a shorter range may succeed.
- **Any number of slices.** Colours come from golden-angle hue rotation, so adjacent slices are
  always far apart in hue and no palette needs maintaining.
- **Cached.** Successful cards are cached for 2 hours; GitHub's camo proxy caches on top of that,
  so README views mostly never reach the deployment.

Errors render as a card too — a broken embed shows a readable message instead of a broken image.

## Deploy your own

Clone this repository, then:

```sh
vercel deploy --prod
vercel env add GITHUB_TOKEN production   # then redeploy: env vars only reach new deployments
```

`GITHUB_TOKEN` is **required** — GitHub's GraphQL API rejects anonymous requests. A classic PAT
with **no scopes** is enough; the token only reads public data and raises the rate limit.

Embed the production URL (`your-project.vercel.app`), not the per-deployment URL. Deployment
URLs are behind Vercel's Deployment Protection and return a login redirect, which GitHub's image
proxy renders as a broken image.

## Development

Use Node.js 22 or newer. There is no dependency installation or build step.

```sh
GITHUB_TOKEN=$(gh auth token) node dev.js   # http://localhost:3000, page + live API
node test.js                               # deterministic tests; no token or network
node test-live.js                          # optional tests against the real GitHub API
```

`test.js` covers calendar boundaries, leap years, repository truncation, request limits and
timeouts, XML escaping, parameter validation, private-repository filtering in every mode, and
snippet state. It uses a fixed clock and GitHub fixtures, so results do not depend on activity
or account settings changing.

`test-live.js` checks the SVG output against real GitHub accounts, including slice percentages,
metric totals, layout, colours, and private contributions. It needs `GITHUB_TOKEN` or a logged-in
`gh`, and can fail if those accounts' activity or privacy settings change.

## Contributing

Issues and pull requests are welcome. Run `node test.js` before opening one. When changing the
GitHub query or aggregation logic, also run `node test-live.js` with GitHub authentication.

## License

[MIT](LICENSE) © YuDavidCao
