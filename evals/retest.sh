#!/usr/bin/env bash
# Retest after a fix batch: regression + simulated users + only the red-team tests that failed last time.
set -u
cd "$(dirname "$0")"
export PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1
OPTS="--no-cache --env-file ../.env -j 1 --delay 6000 --no-progress-bar"
echo "== regression $(date +%T)"; npx promptfoo eval -c regression.yaml $OPTS -o results/regression.json > results/regression.log 2>&1; tail -6 results/regression.log
echo "== simulated $(date +%T)";  npx promptfoo eval -c simulated-users.yaml $OPTS -o results/simulated.json > results/simulated.log 2>&1; tail -6 results/simulated.log
echo "== redteam (previous failures only) $(date +%T)"; npx promptfoo eval -c redteam-generated.yaml $OPTS --filter-failing results/redteam-baseline.json -o results/redteam.json > results/redteam.log 2>&1; tail -6 results/redteam.log
echo "== done $(date +%T)"
