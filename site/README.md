# Download page

The landing page for the Customs Compliance desktop app. Deployed to Heroku as
its own app — separate from the Next.js application, which is not hosted.

Installers are **not** stored here. A Heroku dyno has an ephemeral filesystem and
a 500MB slug limit, and each installer is 150-250MB. They live on GitHub
Releases; this page reads the Releases API, shows what the latest version is, and
redirects downloads to the release assets.

## Deploying

```bash
heroku create customs-compliance
heroku config:set GITHUB_TOKEN=ghp_...   # optional but recommended, see below
git subtree push --prefix site heroku main
```

`GITHUB_TOKEN` only needs public read access. Without it the GitHub API allows
60 requests an hour per IP, which one busy afternoon will exhaust; with it,
5,000. Responses are cached for five minutes either way, and a stale cache is
served if GitHub is unreachable, so the page keeps working through an outage.

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | none | Raises the API rate limit |
| `GITHUB_REPO` | `gitboycryptogeek/customs` | Which repo's releases to read |
| `CACHE_TTL_MS` | `300000` | How long to hold a release lookup |
| `PORT` | `3000` | Set by Heroku |

## Routes

| Route | Purpose |
|---|---|
| `GET /` | The page |
| `GET /api/latest` | Version, notes and per-platform assets as JSON. The desktop app's macOS update check reads this. |
| `GET /download/:os` | 302 to the release asset for `windows`, `macos` or `linux`. Stable link, safe to paste anywhere. |
| `GET /healthz` | Dyno health check |
