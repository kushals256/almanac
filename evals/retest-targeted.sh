#!/usr/bin/env bash
# Targeted rerun for F-51/F-52/F-53.
set -u
cd "$(dirname "$0")"
export PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1
OPTS="--no-cache --env-file ../.env -j 1 --delay 6000 --no-progress-bar"
echo "== regression (targeted) $(date +%T)"; npx promptfoo eval -c regression.yaml $OPTS --filter-pattern '^(brief: .*|memory: yesterday|F-38: .*)$' -o results/regression-targeted.json > results/regression-targeted.log 2>&1; tail -6 results/regression-targeted.log
echo "== redteam (prompt extraction, still failing) $(date +%T)"; npx promptfoo eval -c redteam-generated.yaml $OPTS --filter-failing results/redteam-r2.json -o results/redteam-targeted.json > results/redteam-targeted.log 2>&1; tail -6 results/redteam-targeted.log
echo "== done $(date +%T)"
