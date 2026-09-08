#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly RENDERER="$SCRIPT_DIR/render-app-deployment.sh"
readonly TEMPLATE="$SCRIPT_DIR/../k8s/templates/app-deployment.yaml"
readonly VALID_DIGEST="$(printf '%064d' 0 | tr '0' 'a')"
readonly VALID_IMAGE="registry.example.com/lettuce/app@sha256:$VALID_DIGEST"

readonly TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lettuce-render-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

expect_failure() {
    local description="$1"
    shift
    if "$@" >"$TEST_DIR/stdout" 2>"$TEST_DIR/stderr"; then
        printf 'FAIL: %s unexpectedly succeeded\n' "$description" >&2
        exit 1
    fi
    if [[ -s "$TEST_DIR/stdout" ]]; then
        printf 'FAIL: %s emitted a partial manifest\n' "$description" >&2
        exit 1
    fi
}

readonly RENDERED="$TEST_DIR/rendered.yaml"
"$RENDERER" "$VALID_IMAGE" >"$RENDERED"
"$RENDERER" "localhost:5000/team/lettuce/app@sha256:$VALID_DIGEST" >"$TEST_DIR/localhost-rendered.yaml"

grep -Fq "image: $VALID_IMAGE" "$RENDERED" || {
    printf 'FAIL: valid digest was not rendered exactly\n' >&2
    exit 1
}
if grep -Fq 'LETTUCE_APP_IMAGE_REQUIRED' "$RENDERED"; then
    printf 'FAIL: rendered manifest retained the sentinel\n' >&2
    exit 1
fi
[[ "$(awk '$1 == "image:" && $2 ~ /@sha256:/ { count++ } END { print count + 0 }' "$RENDERED")" == '1' ]] || {
    printf 'FAIL: rendered manifest does not contain exactly one digest-pinned image\n' >&2
    exit 1
}

# Checkup #34 Tier A pin: the app's single-replica in-memory state (login lockout, MFA
# challenges) requires Recreate, never a RollingUpdate overlap, and the pod must run
# non-root — a future edit dropping either regresses silently otherwise.
[[ "$(awk '
    $0 == "  strategy:" { in_strategy = 1; next }
    in_strategy && $0 ~ /^  [^ ]/ { in_strategy = 0 }
    in_strategy && $1 == "type:" && $2 == "Recreate" { count++ }
    END { print count + 0 }
' "$RENDERED")" == '1' ]] || {
    printf 'FAIL: rendered manifest does not set spec.strategy.type: Recreate\n' >&2
    exit 1
}
[[ "$(awk '$1 == "runAsNonRoot:" && $2 == "true" { count++ } END { print count + 0 }' "$RENDERED")" -ge '1' ]] || {
    printf 'FAIL: rendered manifest does not set runAsNonRoot: true\n' >&2
    exit 1
}

expect_failure 'missing image reference' "$RENDERER"
expect_failure 'extra argument' "$RENDERER" "$VALID_IMAGE" unexpected
expect_failure 'local latest tag' "$RENDERER" 'lettuce-app:latest'
expect_failure 'registry tag' "$RENDERER" 'registry.example.com/lettuce/app:release'
expect_failure 'full commit SHA tag' "$RENDERER" 'registry.example.com/lettuce/app:0123456789abcdef0123456789abcdef01234567'
expect_failure 'short digest' "$RENDERER" 'registry.example.com/lettuce/app@sha256:abcdef'
expect_failure 'uppercase digest' "$RENDERER" "registry.example.com/lettuce/app@sha256:$(printf '%064d' 0 | tr '0' 'A')"
expect_failure 'digest without explicit registry path' "$RENDERER" "lettuce-app@sha256:$VALID_DIGEST"
expect_failure 'default registry namespace' "$RENDERER" "myteam/lettuce@sha256:$VALID_DIGEST"
expect_failure 'tag plus digest' "$RENDERER" "registry.example.com/lettuce/app:release@sha256:$VALID_DIGEST"
expect_failure 'whitespace injection' "$RENDERER" "registry.example.com/lettuce/app@sha256:$VALID_DIGEST extra"

# Copy the controlled script/template layout so malformed-template checks exercise the public
# renderer without adding a production template override.
readonly BROKEN_ROOT="$TEST_DIR/broken-repo"
mkdir -p "$BROKEN_ROOT/scripts" "$BROKEN_ROOT/k8s/templates"
cp "$RENDERER" "$BROKEN_ROOT/scripts/render-app-deployment.sh"
cp "$TEMPLATE" "$BROKEN_ROOT/k8s/templates/app-deployment.yaml"
printf '\n# %s\n' 'LETTUCE_APP_IMAGE_REQUIRED' >>"$BROKEN_ROOT/k8s/templates/app-deployment.yaml"
expect_failure 'duplicate template sentinel' "$BROKEN_ROOT/scripts/render-app-deployment.sh" "$VALID_IMAGE"

cp "$TEMPLATE" "$BROKEN_ROOT/k8s/templates/app-deployment.yaml"
printf '\n      - name: unexpected-sidecar\n        image: registry.example.com/sidecar:latest\n' >>"$BROKEN_ROOT/k8s/templates/app-deployment.yaml"
expect_failure 'additional mutable image field' "$BROKEN_ROOT/scripts/render-app-deployment.sh" "$VALID_IMAGE"

awk '
    !moved && $0 == "  annotations:" {
        print
        print "    image: LETTUCE_APP_IMAGE_REQUIRED"
        moved = 1
        next
    }
    $1 == "image:" && $2 == "LETTUCE_APP_IMAGE_REQUIRED" { next }
    { print }
' "$TEMPLATE" >"$BROKEN_ROOT/k8s/templates/app-deployment.yaml"
expect_failure 'image sentinel relocated into metadata annotations' "$BROKEN_ROOT/scripts/render-app-deployment.sh" "$VALID_IMAGE"

printf 'PASS: immutable application deployment renderer\n'
