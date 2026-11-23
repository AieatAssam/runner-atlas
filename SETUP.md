# Setup

This is a one-time checklist for running Runner Atlas in your own GitHub repository. The names below match
the workflows:

- `.github/workflows/atlas.yml`: workflow `atlas`, with jobs `plan`, `collect`, `publish` and `deploy`.
  Collect jobs are named `collect <label> r<replica>`, and `deploy` uses the environment `github-pages`.
- `.github/workflows/ci.yml`: workflow `ci`, with jobs `workflow-lint` (shown as "workflow lint") and
  `verify`.

## 1. Repository

- [ ] Make the repository **public**. The free hosted-runner minutes, and the limits of 20 concurrent jobs
      with 5 on macOS that the matrix is sized for, apply to public repositories.
- [ ] Keep `main` as the default branch. `publish` pushes its data commits to `main`, and `ci` runs on
      pushes to `main` and on pull requests.

## 2. GitHub Pages

- [ ] Settings → Pages → Build and deployment → Source: **GitHub Actions**. The workflow does not run
      `configure-pages`, so this must be set once by hand.
- [ ] Nothing else is needed for the `github-pages` environment. The first `deploy` run creates it.

## 3. Actions permissions

- [ ] Settings → Actions → General → Actions permissions: allow **actions created by GitHub**. That is
      enough, because both workflows use only `actions/*`, each pinned to a commit SHA.
- [ ] Settings → Actions → General → Workflow permissions: either setting works. Both workflows set
      `permissions: {}` at the top, and each job asks only for what it needs:
  - `plan`: `contents: read`
  - `collect`: `contents: read` and `actions: read`
  - `publish`: `contents: write`
  - `deploy`: `pages: write` and `id-token: write`

  The read-only default is the safer choice.

## 4. Branch ruleset on `main`

The ruleset blocks history rewrites and still lets `publish` push its ordinary fast-forward commits.

- [ ] Settings → Rules → Rulesets → New branch ruleset. Target the default branch and set enforcement to
      **Active**.
- [ ] Enable **Restrict deletions** (rule `deletion`).
- [ ] Enable **Block force pushes** (rule `non_fast_forward`).
- [ ] Add no other rules and no bypass actors. "Require a pull request" and "Require status checks" would
      both block the direct push from `publish`. These two rules need no bypass, because `publish` never
      deletes the branch or force-pushes.

## 5. Verify the runner matrix by hand

Run the workflow once by hand before you turn on the schedule.

- [ ] Actions → `atlas` → Run workflow (`workflow_dispatch`) on `main`.
- [ ] `plan` succeeds, and the run lists one `collect` job per enabled replica, 11 in all, each named
      `collect <label> r<replica>`. The collector finds its own job by that exact name, so do not rename
      the job.
- [ ] All six labels produce a sample:

  | Label | Jobs |
  | --- | --- |
  | `ubuntu-24.04` | r1, r2, r3 |
  | `ubuntu-24.04-arm` | r1, r2 |
  | `windows-2025` | r1, r2 |
  | `windows-11-arm` | r1 (optional) |
  | `macos-15` | r1, r2 |
  | `macos-15-intel` | r1 (optional) |

  Each green `collect` job uploads an artifact named `sample-<label>-r<replica>`. An optional label that
  waits in the queue or fails does not fail the run. If one is unavailable to you, disable it (step 7).
- [ ] `publish` succeeds. Its job summary lists any quarantined samples, and it should list none. It
      pushes one commit to `main`, `data: sweep <slot> (<k> samples)`, as `github-actions[bot]`.
- [ ] `deploy` succeeds, and the `github-pages` environment shows the site URL.

## 6. Enable the hourly cron

The schedule (`17 * * * *`, UTC) does nothing until this variable is set, so a fork spends no minutes by
default.

- [ ] Settings → Secrets and variables → Actions → Variables → New repository variable:
      `RUNNER_ATLAS_CRON_ENABLED` = `true`.
- [ ] To pause the survey later, set it to any other value or delete it.

## 7. Optional repository variables

- [ ] `RUNNER_ATLAS_DISABLED_LABELS`: a comma-separated list of labels to skip, for example
      `windows-11-arm,macos-15-intel`. `plan` drops them from the matrix. Use it for a label your account
      cannot run, or one GitHub has retired, which would otherwise sit queued for up to 24 hours.
- [ ] `RUNNER_ATLAS_SITE_URL`: the public site URL, used only for the share tags (`og:url`, `og:image`).
      The default is `https://<owner>.github.io/<repo>/`.
- [ ] `RUNNER_ATLAS_REPO_URL`: you do not need to set this one. In Actions, the footer's repository link
      already defaults to the current repository (`GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`). The variable is
      read only from the build environment, so set it there if you want another link.

No secrets are needed. The workflows use only the built-in `GITHUB_TOKEN`.

## 8. First live sweep

- [ ] Wait for the next run at 17 minutes past the hour (UTC), or run `atlas` by hand.
- [ ] On the Pages URL, check that the sample count is above zero and the synthetic notice is absent.
- [ ] Charts open in tiers over the first 90 days. Until a panel opens, it says what it is waiting for.

## Local checks

```sh
npm ci
npm run verify   # typecheck, unit tests, build, verify:rollups, verify:bundle, verify:collector, e2e
actionlint       # needs actionlint on PATH; CI runs it too
```
