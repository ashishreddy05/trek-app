#!/usr/bin/env bash
# ============================================================================
# NO DEVELOPMENT AUTHENTICATION BYPASS
#
# Fails the build if a bypass appears in src/, migrations/ or scripts/.
# Runs BEFORE the test suite in CI, so a bypass cannot reach a deployable
# artifact even if someone adds one under time pressure.
#
# Scans CODE, not prose: comments and strings-of-explanation are stripped first,
# and patterns are identifier-shaped. An earlier version matched the word
# "bypass" inside the comments that promise there is no bypass, which failed
# the build on a clean tree.
# ============================================================================

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
scan_dirs="src migrations scripts"

# Collect the files once, then strip comments so prose cannot trip a pattern.
files=$(find $scan_dirs -type f \( -name '*.js' -o -name '*.sql' -o -name '*.ts' \) 2>/dev/null)

strip_comments() {
  # //-line, #-line, --SQL-line, and /* */ blocks.
  sed -e 's#//.*$##' -e 's/^[[:space:]]*#.*$//' -e 's/--.*$//' "$1" \
    | awk 'BEGIN{b=0} {
        line=$0
        while (match(line, /\/\*/)) { b=1; line=substr(line,1,RSTART-1) }
        if (b==1) { if (match($0,/\*\//)) { b=0; line=substr($0,RSTART+2) } else { next } }
        print line
      }'
}

# Identifier-shaped, so they match code and not English.
banned=(
  "devCode"
  "dev_code"
  "DEV_CODE"
  "skipAuth"
  "skip_auth"
  "SKIP_AUTH"
  "bypassAuth"
  "authBypass"
  "BYPASS_AUTH"
  "AUTH_BYPASS"
  "mockUser"
  "mock_user"
  "mockLogin"
  "mockAuth"
  "fakeLogin"
  "fakeUser"
  "MASTER_CODE"
  "MASTER_OTP"
  "TEST_OTP"
  "STATIC_OTP"
  "FIXED_CODE"
  "loginAs"
  "impersonate"
  "__dev"
  "DEFAULT_PASSWORD"
  "defaultPassword"
  "default_password"
  "MASTER_PASSWORD"
  "masterPassword"
  "TEMP_PASSWORD"
  "tempPassword"
  "SEED_PASSWORD"
  "seedPassword"
  "skipPassword"
)

echo "→ scanning code for authentication bypasses"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for f in $files; do
  strip_comments "$f" > "$tmp/$(echo "$f" | tr '/' '_')"
done

for pattern in "${banned[@]}"; do
  if hits=$(grep -rnF "$pattern" "$tmp" 2>/dev/null); then
    echo ""
    echo "✗ BANNED IDENTIFIER: $pattern"
    echo "$hits" | sed "s#$tmp/##; s/_/\//g; s/^/    /"
    fail=1
  fi
done

# ---------------------------------------------------------------------------
# A hardcoded six-digit literal is how a "temporary" master code arrives.
# ---------------------------------------------------------------------------
echo "→ scanning for hardcoded six-digit constants"
if hits=$(grep -rnE "['\"][0-9]{6}['\"]" "$tmp" 2>/dev/null); then
  echo ""
  echo "✗ HARDCODED SIX-DIGIT LITERAL — a master code cannot exist:"
  echo "$hits" | sed "s#$tmp/##; s/_/\//g; s/^/    /"
  fail=1
fi

# ---------------------------------------------------------------------------
# The OTP code must never travel in an API response body.
# ---------------------------------------------------------------------------
echo "→ scanning for credentials in response bodies"
if hits=$(grep -rnE "body:[^}]*\b(hash|passwordHash|password_hash|tokenHash|token_hash|link\.url|resetUrl|inviteUrl)\b" "$tmp" 2>/dev/null); then
  echo ""
  echo "✗ POSSIBLE CREDENTIAL LEAK INTO A RESPONSE BODY:"
  echo "$hits" | sed "s#$tmp/##; s/_/\//g; s/^/    /"
  fail=1
fi

# ---------------------------------------------------------------------------
# The prototype's browser-local data layer must never be imported.
# ---------------------------------------------------------------------------
echo "→ scanning for prototype data-layer imports"
if hits=$(grep -rniF "trek-data" "$tmp" 2>/dev/null); then
  echo ""
  echo "✗ PROTOTYPE DATA LAYER IMPORTED — trek-data.js is a browser-local prototype store:"
  echo "$hits" | sed "s#$tmp/##; s/_/\//g; s/^/    /"
  fail=1
fi

# ---------------------------------------------------------------------------
# The destructive staging reset must never be reachable in production.
# ---------------------------------------------------------------------------
echo "→ verifying the staging reset is environment-guarded"
if [ -f scripts/reset-staging.js ]; then
  if ! grep -qF "APP_ENV" scripts/reset-staging.js; then
    echo "✗ scripts/reset-staging.js does not check APP_ENV"
    fail=1
  fi
  if ! grep -qF "schema_migrations" scripts/reset-staging.js; then
    echo "✗ scripts/reset-staging.js must explicitly protect schema_migrations"
    fail=1
  fi
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "✓ no authentication bypass found"
  exit 0
fi

cat <<'EOF'
──────────────────────────────────────────────────────────────────────
BUILD REFUSED.

The pilot requires real passwordless email OTP with no developer
bypass, no dev code, no screen-displayed OTP and no mock login.
Remove the findings above; do not add them to an allowlist.
──────────────────────────────────────────────────────────────────────
EOF
exit 1
