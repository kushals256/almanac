#!/usr/bin/env bash
# Rerun only what failed in the previous retest. Regression/simulated tests are selected by name
# (Promptfoo redacts `sessionId` in saved results, so --filter-failing can't rebuild those tests);
# red-team tests regenerate their chat id via transformVars, so --filter-failing works there.
set -u
cd "$(dirname "$0")"
export PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1
OPTS="--no-cache --env-file ../.env -j 1 --delay 6000 --no-progress-bar"
REG=$(sed -n 1p results/rerun-patterns.txt); SIM=$(sed -n 2p results/rerun-patterns.txt)
echo "== regression (previous failures) $(date +%T)"; npx promptfoo eval -c regression.yaml $OPTS --filter-pattern "$REG" -o results/regression.json > results/regression.log 2>&1; tail -6 results/regression.log
echo "== simulated (previous failures) $(date +%T)"; npx promptfoo eval -c simulated-users.yaml $OPTS --filter-pattern "$SIM" -o results/simulated.json > results/simulated.log 2>&1; tail -6 results/simulated.log
echo "== redteam (previous failures) $(date +%T)"; npx promptfoo eval -c redteam-generated.yaml $OPTS --filter-failing results/redteam-r1.json -o results/redteam.json > results/redteam.log 2>&1; tail -6 results/redteam.log
echo "== done $(date +%T)"
