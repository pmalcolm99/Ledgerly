#!/usr/bin/env bash
# scripts/test-gitleaks-config.sh
#
# Proves `.gitleaks.toml` still detects real secrets.
#
# A gitleaks config with no `[[rules]]` of its own REPLACES the default
# ruleset unless it carries `[extend] useDefault = true`. Drop that one line
# and every scan reports "no leaks found" while checking nothing -- a control
# that passes by doing nothing, which is worse than no control because it
# stops anyone looking. This script plants known-bad credentials in a
# scratch directory and asserts they are caught.
#
# Usage:  ./scripts/test-gitleaks-config.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${GITLEAKS_VERSION:-v8.24.3}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cp "$REPO_ROOT/.gitleaks.toml" "$SCRATCH/.gitleaks.toml"

# Synthetic credentials, ASSEMBLED AT RUNTIME.
#
# They are deliberately not written as literals: the pre-commit hook runs
# secretlint over every staged file, and an inline `ghp_...` in this script
# is a finding like any other -- the first version of this file was refused
# by its own project's tooling, which is the control behaving correctly.
# Splitting the prefix keeps the literal out of the source while the file
# written below still carries the real shape.
#
# Deliberately NOT AWS's `AKIAIOSFODNN7EXAMPLE`: that is the canonical AWS
# documentation key and it sits in gitleaks' own default stopword list, so it
# is correctly ignored. Using it here made this script fail against a config
# that was working fine -- the assertions below name the rules they expect
# instead of counting findings, for exactly that reason.
#
# The Anthropic value is full length on purpose. The rule carries an 80-char
# floor so it does not flag this repo's deliberately-short fake fixtures, and
# a stub-length value here would pass while proving nothing.
GH_PREFIX='ghp'
ANT_PREFIX='sk-ant'
ANT_BODY='C3J27XDCG2LmlZGEONYlgCtjfIZ4SOcMz9CPVNPkNa1Hedcm4pMbXDuCL1mHoOsFaQfDPrAJ71fTquWoGsbeKXgzg2sye9bAA'
{
  printf 'github_pat = %s_%s\n' "$GH_PREFIX" '012345678901234567890123456789abcdef'
  printf 'anthropic_key = %s-api03-%s\n' "$ANT_PREFIX" "$ANT_BODY"
} > "$SCRATCH/planted.txt"

# And the fixture the allowlist exists for, which must NOT be reported.
cat > "$SCRATCH/allowed.test.ts" <<'OK'
const headers = new Headers({ "cf-access-jwt-assertion": "sub-owner-f7a" });
OK

runner() {
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks "$@"
  else
    docker run --rm -v "$SCRATCH:/scan" "zricethezav/gitleaks:$VERSION" "$@"
  fi
}

set +e
OUT="$(runner detect --source=/scan --no-git --redact --no-banner -v 2>&1)"
set -e

FOUND="$(printf '%s' "$OUT" | grep -c 'RuleID:' || true)"

# Assert a NAMED default rule fired. A count alone is a weak assertion --
# the allowlist regex or a stopword could change what matches -- but
# `github-pat` firing can only happen if the default ruleset is loaded.
if ! printf '%s' "$OUT" | grep -q 'RuleID: *anthropic-api-key'; then
  echo "FAIL: the custom 'anthropic-api-key' rule did not fire ($FOUND findings)." >&2
  echo "      This repo's most sensitive credential would reach a commit." >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

if ! printf '%s' "$OUT" | grep -q 'RuleID: *github-pat'; then
  echo "FAIL: the default rule 'github-pat' did not fire ($FOUND findings)." >&2
  echo "      .gitleaks.toml is probably missing '[extend] useDefault = true'," >&2
  echo "      which replaces the default ruleset instead of adding to it." >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

if printf '%s' "$OUT" | grep -q 'cf-access-jwt-assertion'; then
  echo "FAIL: the benign test fixture was reported; the allowlist is not working." >&2
  exit 1
fi

echo "PASS: $FOUND planted credential(s) detected, benign fixture allowlisted."
