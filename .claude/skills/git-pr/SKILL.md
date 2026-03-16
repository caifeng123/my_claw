---
name: git-pr
description: >
  Auto-push local uncommitted changes to a new branch and create a Pull Request (GitHub) or
  Merge Request (GitLab), then return the PR/MR link with a detailed AI-generated summary.
  Supports both GitHub (via gh CLI) and self-hosted GitLab (via glab CLI).
  Use when the user wants to: (1) push local changes and create a PR/MR in one step,
  (2) auto-generate a PR description from diff, (3) quickly submit code for review.
  Trigger keywords: /git-pr, "提交PR", "创建PR", "提交MR", "创建MR", "推代码",
  "提交一个PR", "帮我创建合并请求", "push and create PR", "submit a PR",
  "create a pull request", "create a merge request".
---

# Git-PR

One-command workflow: prepare → AI commit → push + create PR → AI describe.

## Prerequisites

### GitHub
```bash
brew install gh        # or see https://cli.github.com/
gh auth login          # one-time
```

### GitLab (self-hosted)
```bash
brew install glab      # or see https://gitlab.com/gitlab-org/cli
glab auth login --hostname your-gitlab-host.com
```

## Workflow

### Step 1: Prepare — Stage changes and export diff

Run the prepare script:

```bash
bash {SKILL_PATH}/scripts/git_prepare.sh
```

Optional: `--target <branch>` to override target branch.

Parse the output key-value pairs:
- `HAS_CHANGES`: `true` if uncommitted changes were found and committed
- `ALREADY_COMMITTED`: `true` if no uncommitted changes but unpushed commits exist
- `DIFF_FILE`: Path to full diff content
- `STAT_FILE`: Path to diff stats
- `COMMIT_SHA`: The placeholder commit SHA (only when HAS_CHANGES=true)

**If `HAS_CHANGES=false` and `ALREADY_COMMITTED=false`**: Inform user there's nothing to submit. Stop.

**If `ALREADY_COMMITTED=true`**: Skip Step 2 (commit already has a real message). Go to Step 3.

### Step 2: AI Amend — Generate meaningful commit message

Read `DIFF_FILE` and `STAT_FILE`, then generate a **Conventional Commits** style message:

Format: `<type>(<scope>): <short description>`

- **type**: `feat` / `fix` / `refactor` / `docs` / `chore` / `style` / `test` / `perf` / `ci` / `build`
- **scope**: primary module or directory affected (e.g., `memory`, `feishu`, `agent`, `api`). Optional but preferred.
- **description**: imperative mood, lowercase, no period, max 72 chars. Describe **what** the change does semantically.

Examples:
- `feat(memory): add SQLite FTS5 full-text search engine`
- `fix(feishu): resolve session mapping for topic groups`
- `refactor(agent): extract system prompt builder to separate module`
- `docs: add data directory README and gitignore rules`
- `chore(deps): downgrade better-sqlite3 to v9.6.0`

Then amend the placeholder commit:

```bash
git commit --amend -m "<generated message>"
```

If the user provided `-m "..."`, use that message instead.

### Step 3: Push and Create PR

Run the push script:

```bash
bash {SKILL_PATH}/scripts/git_push_pr.sh
```

Optional: `--target <branch>` (same value as Step 1 if used).

Parse the output:
- `PLATFORM`: `github` or `gitlab`
- `PR_URL`: The PR/MR link
- `PR_NUMBER`: For updating title/description later
- `NEW_BRANCH`: The remote branch created
- `TARGET_BRANCH`: The merge target
- `DIFF_FILE`: Path to diff (for generating PR description)
- `STAT_FILE`: Path to diff stats

### Step 4: AI Update PR — Generate title and description

Read `DIFF_FILE` and `STAT_FILE`, generate a PR summary:

```markdown
## Summary
> use chinese language
[2-3 sentences: what this PR does and why]

## Changes
> use chinese language
- **module_or_file**: description of what changed
- ...

## Stats
[X files changed, Y insertions(+), Z deletions(-)]
```

Then update the PR automatically:

**GitHub:**
```bash
echo "$SUMMARY" > /tmp/pr_summary.md
gh pr edit {PR_NUMBER} --title "<commit message>" --body-file /tmp/pr_summary.md
rm -f /tmp/pr_summary.md
```

**GitLab:**
```bash
echo "$SUMMARY" > /tmp/mr_summary.md
glab mr update {PR_NUMBER} --title "<commit message>" --description "$(cat /tmp/mr_summary.md)"
rm -f /tmp/mr_summary.md
```

Rules:
- Always update BOTH title and body automatically — never ask user
- Use `--body-file` for GitHub to avoid shell escaping issues
- If update fails, still return the link and note: "PR description auto-update failed. You can manually paste the content above."

### Step 5: Cleanup and Present

Clean up temp files:
```bash
rm -f {DIFF_FILE} {STAT_FILE}
```

Return to user:
1. PR/MR link (clickable)
2. Commit message used
3. PR summary generated

## Error Handling

| Error | Action |
|-------|--------|
| Not in git repo | Ask user to cd into repo |
| gh/glab not installed | Show install instructions |
| gh/glab not authenticated | Guide through auth login |
| No remote | Ask user to add origin |
| No default branch | Ask to specify --target |
| Push failed | Check keys/network |
| No changes | Inform user, stop |
| Amend failed | Keep placeholder commit, continue push |
| PR edit failed | Return link + summary, suggest manual paste |
