#!/usr/bin/env bash
#
# git_pr.sh - Auto-push local changes to a new branch and create PR/MR.
#
# Usage:
#   bash git_pr.sh [--target <branch>] [--message <commit_msg>]
#
# Options:
#   --target   Target branch (optional, auto-detects main/master)
#   --message  Commit message (optional, auto-generated from diff)
#
set -euo pipefail

# ========== Logging ==========
info()  { echo "[INFO] $*"; }
warn()  { echo "[WARN] $*"; }
error() { echo "[ERROR] $*" >&2; }
ok()    { echo "[OK] $*"; }

# ========== Cleanup trap ==========
CLEANUP_FILES=()
cleanup() {
    for f in "${CLEANUP_FILES[@]}"; do
        rm -f "$f" 2>/dev/null || true
    done
}
trap cleanup EXIT

# ========== Argument parsing ==========
TARGET_BRANCH=""
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)  TARGET_BRANCH="$2"; shift 2 ;;
        --message) COMMIT_MSG="$2"; shift 2 ;;
        *) error "Unknown option: $1"; exit 1 ;;
    esac
done

# ========== Pre-checks ==========

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    error "Not inside a git repository. Please cd into one first."
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Detect platform
detect_platform() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ -z "$remote_url" ]]; then
        error "No origin remote detected. Please add one first."
        exit 1
    fi
    if echo "$remote_url" | grep -qiE "github\.com"; then
        echo "github"
    else
        echo "gitlab"
    fi
}

PLATFORM=$(detect_platform)
info "Platform: $PLATFORM"

# Check CLI availability
if [[ "$PLATFORM" == "github" ]]; then
    if ! command -v gh &>/dev/null; then
        error "gh CLI not installed. Install: https://cli.github.com/"
        error "Then run: gh auth login"
        exit 1
    fi
    if ! gh auth status &>/dev/null 2>&1; then
        error "gh CLI not authenticated. Run: gh auth login"
        exit 1
    fi
else
    if ! command -v glab &>/dev/null; then
        error "glab CLI not installed. Install: https://gitlab.com/gitlab-org/cli"
        error "Then run: glab auth login"
        exit 1
    fi
    if ! glab auth status &>/dev/null 2>&1; then
        error "glab CLI not authenticated. Run: glab auth login"
        exit 1
    fi
fi

# ========== Detect target branch ==========
detect_default_branch() {
    local db
    db=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "")
    if [[ -n "$db" ]]; then
        echo "$db"
        return
    fi
    for b in main master; do
        if git show-ref --verify --quiet "refs/remotes/origin/$b" 2>/dev/null; then
            echo "$b"
            return
        fi
    done
    error "Cannot detect default branch. Use --target to specify."
    exit 1
}

if [[ -z "$TARGET_BRANCH" ]]; then
    TARGET_BRANCH=$(detect_default_branch)
fi
info "Target branch: $TARGET_BRANCH"

# ========== Detect changes ==========

STAGED_COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
UNSTAGED_COUNT=$(git diff --name-only | wc -l | tr -d ' ')
UNTRACKED_COUNT=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')
TOTAL_CHANGES=$((STAGED_COUNT + UNSTAGED_COUNT + UNTRACKED_COUNT))

if [[ "$TOTAL_CHANGES" -eq 0 ]]; then
    UNPUSHED=$(git log "origin/$TARGET_BRANCH..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$UNPUSHED" -eq 0 ]]; then
        warn "No changes or unpushed commits detected. Nothing to do."
        exit 0
    else
        info "Found $UNPUSHED unpushed commit(s)."
    fi
else
    info "Changes: $STAGED_COUNT staged, $UNSTAGED_COUNT unstaged, $UNTRACKED_COUNT untracked"
fi

# ========== Create branch and commit ==========

TIMESTAMP=$(date +%Y%m%d%H%M%S)
NEW_BRANCH="auto-pr-${TIMESTAMP}"
ORIG_BRANCH=$(git branch --show-current 2>/dev/null || echo "")

info "Creating branch: $NEW_BRANCH"
git checkout -b "$NEW_BRANCH"

if [[ "$TOTAL_CHANGES" -gt 0 ]]; then
    git add -A
fi

# Generate diff
DIFF_OUTPUT=""
DIFF_DETAIL=""

if [[ "$TOTAL_CHANGES" -gt 0 ]]; then
    DIFF_OUTPUT=$(git diff --cached --stat 2>/dev/null || echo "")
    DIFF_DETAIL=$(git diff --cached 2>/dev/null || echo "")
fi

# Fallback for unpushed commits
if [[ -z "$DIFF_OUTPUT" ]]; then
    DIFF_OUTPUT=$(git diff "origin/$TARGET_BRANCH"..HEAD --stat 2>/dev/null || echo "")
    DIFF_DETAIL=$(git diff "origin/$TARGET_BRANCH"..HEAD 2>/dev/null || echo "")
fi

CHANGED_FILES=$(echo "$DIFF_OUTPUT" | head -30)

# ========== Smart commit message ==========
if [[ -z "$COMMIT_MSG" ]]; then
    # Find the most changed directory to make message more descriptive
    TOP_DIR=$(echo "$DIFF_OUTPUT" | head -20 | grep -oE '^ [^ ]+' | sed 's|^ ||' | \
        awk -F'/' '{if(NF>1) print $1; else print "(root)"}' | \
        sort | uniq -c | sort -rn | head -1 | awk '{print $2}' || echo "")
    FILE_COUNT=$(echo "$DIFF_OUTPUT" | tail -1 | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo "several")

    if [[ -n "$TOP_DIR" && "$TOP_DIR" != "(root)" ]]; then
        COMMIT_MSG="auto: update ${TOP_DIR} (${FILE_COUNT} file(s)) via git-pr"
    else
        COMMIT_MSG="auto: update ${FILE_COUNT} file(s) via git-pr"
    fi
fi

if [[ "$TOTAL_CHANGES" -gt 0 ]]; then
    git commit -m "$COMMIT_MSG"
fi

# ========== Push ==========

info "Pushing $NEW_BRANCH to origin..."
if ! git push -u origin "$NEW_BRANCH" 2>&1; then
    error "Push failed. Check config and network."
    if [[ -n "$ORIG_BRANCH" ]]; then
        git checkout "$ORIG_BRANCH" 2>/dev/null || true
    fi
    git branch -D "$NEW_BRANCH" 2>/dev/null || true
    exit 1
fi

# ========== Save diff for AI analysis (with size limit) ==========
MAX_DIFF_LINES=50000

DIFF_FILE=$(mktemp /tmp/git_pr_diff_XXXXXX.txt)
CLEANUP_FILES+=("$DIFF_FILE")
echo "$DIFF_DETAIL" | head -"$MAX_DIFF_LINES" > "$DIFF_FILE"

STAT_FILE=$(mktemp /tmp/git_pr_stat_XXXXXX.txt)
CLEANUP_FILES+=("$STAT_FILE")
echo "$DIFF_OUTPUT" > "$STAT_FILE"

DIFF_LINES=$(echo "$DIFF_DETAIL" | wc -l | tr -d ' ')
if [[ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]]; then
    info "Diff truncated: $DIFF_LINES lines -> $MAX_DIFF_LINES lines"
    echo "" >> "$DIFF_FILE"
    echo "... (truncated, $DIFF_LINES total lines)" >> "$DIFF_FILE"
fi

# ========== Create PR/MR ==========

PR_TITLE="$COMMIT_MSG"

# Build PR body safely using printf (avoid heredoc escaping issues)
PR_BODY=$(printf "## Changes\n\n### Files Changed\n\`\`\`\n%s\n\`\`\`\n\n> Auto-generated by git-pr skill. Detailed description will be updated shortly." "$CHANGED_FILES")

PR_NUMBER=""
if [[ "$PLATFORM" == "github" ]]; then
    info "Creating Pull Request via gh CLI..."

    # Write body to temp file to avoid shell escaping issues
    BODY_FILE=$(mktemp /tmp/git_pr_body_XXXXXX.md)
    CLEANUP_FILES+=("$BODY_FILE")
    printf "%s" "$PR_BODY" > "$BODY_FILE"

    PR_URL=$(gh pr create \
        --base "$TARGET_BRANCH" \
        --head "$NEW_BRANCH" \
        --title "$PR_TITLE" \
        --body-file "$BODY_FILE" 2>&1) || {
        error "PR creation failed: $PR_URL"
        exit 1
    }
    PR_NUMBER=$(echo "$PR_URL" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+' || echo "")
else
    info "Creating Merge Request via glab CLI..."
    MR_OUTPUT=$(glab mr create \
        --source-branch "$NEW_BRANCH" \
        --target-branch "$TARGET_BRANCH" \
        --title "$PR_TITLE" \
        --description "$PR_BODY" \
        --remove-source-branch \
        -y 2>&1) || {
        error "MR creation failed: $MR_OUTPUT"
        exit 1
    }
    PR_URL=$(echo "$MR_OUTPUT" | grep -oE 'https?://[^ ]+' | head -1)
    if [[ -z "$PR_URL" ]]; then
        PR_URL="$MR_OUTPUT"
    fi
    PR_NUMBER=$(echo "$PR_URL" | grep -oE 'merge_requests/[0-9]+' | grep -oE '[0-9]+' || echo "")
fi

# ========== Output ==========
echo ""
echo "============================================"
echo "  GIT-PR RESULT"
echo "============================================"
echo ""
ok "PR/MR created successfully!"
echo ""
echo "PLATFORM=$PLATFORM"
echo "PR_URL=$PR_URL"
echo "NEW_BRANCH=$NEW_BRANCH"
echo "TARGET_BRANCH=$TARGET_BRANCH"
echo "DIFF_FILE=$DIFF_FILE"
echo "STAT_FILE=$STAT_FILE"
echo "PR_NUMBER=$PR_NUMBER"
echo ""
echo "============================================"

# Note: DIFF_FILE and STAT_FILE will be cleaned up by trap on exit.
# If the calling agent needs them, it should read them before this script exits.
# In practice, the agent reads them in a separate bash call, so the trap
# won't fire until THIS script's shell exits. The files persist across calls.
# The trap is a safety net for abnormal exits only.
# For normal flow: the agent orchestrator handles cleanup after reading.

# Actually, disable cleanup for DIFF_FILE and STAT_FILE so the agent can read them
# They will be in /tmp and cleaned by OS eventually
CLEANUP_FILES=()
