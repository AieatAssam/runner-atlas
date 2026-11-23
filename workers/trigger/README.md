# Runner Atlas Hourly Cloudflare Worker Trigger

Free-tier Cloudflare Worker (`runner-atlas-trigger`) that invokes GitHub Actions `workflow_dispatch` on `.github/workflows/atlas.yml` every hour at `:17 UTC` (`17 * * * *`).

## Why this exists

GitHub's native `on: schedule` runs on a best-effort queue that can delay or skip triggers on personal and newly created repositories. Leaving `on: schedule` untouched in `atlas.yml` preserves genuine GitHub `schedule` runs for `cronDriftSec` and the Drift panel whenever GitHub dispatches them, while this Worker ensures steady hourly sweeps for Fleet, Benchmarks, Regions, Neighbours, and Rollouts.

Before dispatching, the Worker checks the 5 latest workflow runs and skips the dispatch if a run is currently active or was created within `DEDUPE_WINDOW_MINUTES` (default `20`), avoiding overlapping sweeps when GitHub's native schedule fires near `:17`.

## Cloudflare Free Tier footprint

- **Cron Triggers**: 1 of 3 free triggers used (`17 * * * *`)
- **Requests / invocations**: 24 scheduled runs/day (0.024% of the 100,000/day free limit)
- **Public HTTP surface**: `workers_dev = false` and `preview_urls = false`; `fetch()` returns `404`

## GitHub Fine-Grained PAT setup

Create a fine-grained personal access token at `https://github.com/settings/personal-access-tokens/new` scoped as narrowly as possible:

- **Repository access**: Only select repositories -> `AieatAssam/runner-atlas`
- **Repository permissions**: `Actions: Read and write` (no other permissions)

## Deploy & secret commands

Run from `workers/trigger/`:

```sh
# 1. Authenticate (or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
npx --yes wrangler@latest login

# 2. Deploy the Worker and register the :17 UTC cron trigger
npx --yes wrangler@latest deploy

# 3. Upload the encrypted GitHub PAT secret (never committed)
npx --yes wrangler@latest secret put GITHUB_TOKEN
```

## Operations

- **Check live deployments**:
  ```sh
  npx --yes wrangler@latest deployments list
  ```
- **Tail cron logs**:
  ```sh
  npx --yes wrangler@latest tail
  ```
- **Pause without undeploying**: set `ENABLED = "false"` in `wrangler.toml` (or in the Cloudflare Dashboard Worker Variables) and redeploy, or remove the deployment with `npx --yes wrangler@latest delete`.
