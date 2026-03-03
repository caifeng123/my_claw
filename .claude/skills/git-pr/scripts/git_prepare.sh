#!/usr/bin/env bash
#
# git_prepare.sh - Stage changes, export diff, create placeholder commit.
# Called by AI before analyzing diff and amending commit message.
#
# Usage:
#   bash git_prepare.sh [--target <branch>]
#
# Output (key=value pairs for AI to parse):
#   DIFF_FILE=<path>    Full diff content
#   STAT_FILE=<path>    Diff stat summary
#   HAS_CHANGES=true|false
#   COMMIT_SHA=<sha>    The placeholder commit SHA
#
set -euo pipefail

info()  { echo "[INFO] $*"; }
warn()  { echo "[WARN] $*"; }
error() { echo "[ERROR] $*" >&2; }

# ========== Args ==========
TARGET_BRANCH=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) TARGET_BRANCH="$2"; shift 2 ;;
        *) error "Unknown option: $1"; exit 1 ;;
    esac
done

# ========== Pre-checks ==========
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    error "Not inside a git repository."
    exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# ========== Detect target branch ==========
if [[ -z "$TARGET_BRANCH" ]]; then
    TARGET_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "")
    if [[ -z "$TARGET_BRANCH" ]]; then
        for b in main master; do
            if git show-ref --verify --quiet "refs/remotes/origin/$b" 2>/dev/null; then
                TARGET_BRANCH="$b"
                break
            fi
        done
    fi
    if [[ -z "$TARGET_BRANCH" ]]; then
        error "Cannot detect default branch. Use --target to specify."
        exit 1
    fi
fi

# ========== Check for changes ==========
STAGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
UNSTAGED=$(git diff --name-only | wc -l | tr -d ' ')
UNTRACKED=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')
TOTAL=$((STAGED + UNSTAGED + UNTRACKED))

if [[ "$TOTAL" -eq 0 ]]; then
    # Check for existing unpushed commits
    UNPUSHED=$(git log "origin/$TARGET_BRANCH..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$UNPUSHED" -gt 0 ]]; then
        info "No uncommitted changes, but found $UNPUSHED unpushed commit(s). Skipping prepare."
        # Export diff of unpushed commits for AI analysis
        DIFF_FILE=$(mktemp /tmp/git_pr_diff_XXXXXX.txt)
        STAT_FILE=$(mktemp /tmp/git_pr_stat_XXXXXX.txt)
        git diff "origin/$TARGET_BRANCH"..HEAD > "$DIFF_FILE"
        git diff "origin/$TARGET_BRANCH"..HEAD --stat > "$STAT_FILE"
        echo ""
        echo "HAS_CHANGES=false"
        echo "ALREADY_COMMITTED=true"
        echo "UNPUSHED_COUNT=$UNPUSHED"
        echo "DIFF_FILE=$DIFF_FILE"
        echo "STAT_FILE=$STAT_FILE"
        exit 0
    fi
    warn "No changes detected. Nothing to do."
    echo "HAS_CHANGES=false"
    echo "ALREADY_COMMITTED=false"
    exit 0
fi

info "Changes: $STAGED staged, $UNSTAGED unstaged, $UNTRACKED untracked"

# ========== Stage all ==========
git add -A

# ========== Export diff ==========
MAX_DIFF_LINES=50000

DIFF_FILE=$(mktemp /tmp/git_pr_diff_XXXXXX.txt)
STAT_FILE=$(mktemp /tmp/git_pr_stat_XXXXXX.txt)

git diff --cached --stat > "$STAT_FILE"
DIFF_DETAIL=$(git diff --cached)
DIFF_LINES=$(echo "$DIFF_DETAIL" | wc -l | tr -d ' ')
echo "$DIFF_DETAIL" | head -"$MAX_DIFF_LINES" > "$DIFF_FILE"

if [[ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]]; then
    info "Diff truncated: $DIFF_LINES -> $MAX_DIFF_LINES lines"
    echo -e "\n... (truncated, $DIFF_LINES total lines)" >> "$DIFF_FILE"
fi

# ========== Placeholder commit ==========
git commit -m "wip: pending AI analysis"
COMMIT_SHA=$(git rev-parse HEAD)

info "Placeholder commit created: $COMMIT_SHA"

# ========== Output ==========
echo ""
echo "HAS_CHANGES=true"
echo "ALREADY_COMMITTED=false"
echo "DIFF_FILE=$DIFF_FILE"
echo "STAT_FILE=$STAT_FILE"
echo "COMMIT_SHA=$COMMIT_SHA"
