#!/usr/bin/env bash
# Publishes one sweep (SPEC 2): ingest .tmp/incoming/<artifact>/sample.json into data/raw, rebuild and validate
# data/rollups, commit as github-actions[bot], push. Each of up to 3 attempts starts from a fresh origin/main
# (fetch + reset --hard), so a rejected push is retried on the newer main; ingest is idempotent. Never force-pushes.
set -euo pipefail

cd "$(dirname "$0")/.."

INCOMING=".tmp/incoming"
MAX_ATTEMPTS=3
BRANCH="main"

log() { printf 'publish: %s\n' "$*"; }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# actions/download-artifact with merge-multiple: false lays out one directory per artifact.
shopt -s nullglob
incoming_files=("$INCOMING"/*/sample.json)
shopt -u nullglob
if [ ${#incoming_files[@]} -eq 0 ]; then
  log "no incoming samples in $INCOMING, nothing to publish"
  summary "publish: no incoming samples"
  exit 0
fi

attempt=1
while :; do
  git fetch -q --depth=1 origin "$BRANCH"
  git reset -q --hard FETCH_HEAD

  # Quarantined samples are listed by artifact and reason only; they are never written to data/.
  out="$(node aggregator/src/cli.ts ingest "${incoming_files[@]}")"
  printf '%s\n' "$out"
  if [ "$attempt" -eq 1 ]; then
    while IFS= read -r line; do
      case "$line" in quarantined\ *) summary "- $line" ;; esac
    done <<< "$out"
  fi
  result="$(printf '%s\n' "$out" | sed -n 's/^result: //p')"
  added="$(printf '%s\n' "$result" | sed -En 's/.*added=([0-9]+).*/\1/p')"
  slot_iso="$(printf '%s\n' "$result" | sed -En 's/.*slot=([^ ]+).*/\1/p')"

  node aggregator/src/cli.ts rollup
  node aggregator/src/cli.ts validate

  git add data/raw data/rollups
  if git diff --cached --quiet -- data/raw data/rollups; then
    log "no change to commit for $slot_iso"
    summary "publish: no change for $slot_iso"
    exit 0
  fi

  git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "data: sweep $slot_iso ($added samples)"

  if git push -q origin "HEAD:refs/heads/$BRANCH"; then
    log "pushed sweep $slot_iso with $added samples on attempt $attempt"
    summary "publish: pushed sweep $slot_iso ($added samples), attempt $attempt"
    exit 0
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    log "push rejected after $MAX_ATTEMPTS attempts"
    summary "publish: push failed after $MAX_ATTEMPTS attempts for $slot_iso"
    exit 1
  fi
  attempt=$((attempt + 1))
  log "push rejected, retrying on a fresh origin/$BRANCH (attempt $attempt)"
done
