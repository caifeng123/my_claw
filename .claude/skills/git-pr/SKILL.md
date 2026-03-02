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

One-command workflow: stage all local changes → commit → push to a new branch → create PR/MR → return link + AI summary.

## Prerequisites

Users must set up CLI tools **once** (one-time setup):

### GitHub

```bash
# Install gh CLI (macOS)
brew install gh
# Or Linux: see https://cli.github.com/

# Authenticate (one-time)
gh auth login
```

### GitLab (self-hosted)

```bash
# Install glab CLI
brew install glab
# Or see https://gitlab.com/gitlab-org/cli

# Authenticate with self-hosted instance (one-time)
glab auth login --hostname your-gitlab-host.com
```

Push uses the default remote transport (typically key-based auth). `gh`/`glab` CLI manage their own API tokens internally.

## Workflow

1. Run `scripts/git_pr.sh` in the user's repo directory
2. Read the diff output files produced by the script
3. Generate a professional PR/MR title and summary based on the diff
4. Present the PR/MR link and summary to the user
5. Update PR/MR title and description with the AI-generated content

### Step 1: Execute the Script

Run the script from the user's current working directory (must be inside a git repo):

```bash
bash {SKILL_PATH}/scripts/git_pr.sh
```

Optional parameters:
- `--target <branch>`: Override target branch (default: auto-detect main/master)
- `--message <msg>`: Override commit message (default: auto-generated)

The script outputs structured key-value pairs. Parse these from the output:
- `PLATFORM`: "github" or "gitlab"
- `PR_URL`: The created PR/MR link
- `PR_NUMBER`: The PR/MR number (for updating title/description later)
- `NEW_BRANCH`: The new branch name (auto-pr-{timestamp})
- `TARGET_BRANCH`: The target branch
- `DIFF_FILE`: Path to temp file with full diff content
- `STAT_FILE`: Path to temp file with diff stats

### Step 2: Read Diff and Generate Title + Summary

After the script succeeds, read `DIFF_FILE` and `STAT_FILE` to generate BOTH a title and a summary.

#### Title Generation

Generate a **Conventional Commits** style title that describes the semantic meaning of the change:

```
<type>(<scope>): <short description>
```

Rules:
- `type`: feat / fix / refactor / docs / style / test / chore / build / ci / perf
- `scope`: the primary module, directory, or component affected (optional but preferred)
- `short description`: imperative mood, lowercase, no period, max 72 chars

Examples:
- `feat(auth): add JWT token validation middleware`
- `fix(api): resolve timeout on large payload requests`
- `refactor: migrate config files to new schema format`
- `docs(readme): update installation instructions for Linux`
- `chore(deps): bump axios from 0.21 to 1.6`

If the change spans multiple unrelated areas, use the most significant one for scope, or omit scope:
- `refactor: reorganize project structure and update configs`

#### Summary Generation

The summary must include:

```
## PR Summary

### Overview
[One-sentence description of what this change does]

### Change Type
[feat / fix / refactor / docs / style / test / chore]

### Changes
- **file_or_module_1**: Description of what changed and why
- **file_or_module_2**: Description of what changed and why
  ...

### Stats
[X files changed, Y insertions(+), Z deletions(-)]
```

Guidelines for summary generation:
- Group related file changes together by module/feature
- Focus on **what** changed and **why**, not line-by-line diffs
- Keep descriptions concise but informative
- If diff is too large (>500 lines), summarize by module rather than by file
- If diff was truncated (indicated by "truncated" in the file), note this in the summary

### Step 3: Present Results to User

Return to the user:

1. **PR/MR Link** — clickable URL
2. **Title** — the generated Conventional Commits title
3. **Summary** — the generated summary from Step 2

### Step 4: Update PR Title and Description (CRITICAL - must execute automatically)

After presenting to the user, **automatically update BOTH the PR/MR title and description**.

**For GitHub** (use `--body-file` to avoid shell escaping issues):
```bash
# Write summary to temp file first
echo "$SUMMARY_MARKDOWN" > /tmp/pr_summary.md
gh pr edit {PR_NUMBER} --title "{GENERATED_TITLE}" --body-file /tmp/pr_summary.md
rm -f /tmp/pr_summary.md
```

**For GitLab:**
```bash
echo "$SUMMARY_MARKDOWN" > /tmp/mr_summary.md
glab mr update {PR_NUMBER} --title "{GENERATED_TITLE}" --description "$(cat /tmp/mr_summary.md)"
rm -f /tmp/mr_summary.md
```

IMPORTANT rules for this step:
- This MUST happen automatically - never ask the user whether to update
- Always update BOTH title AND body/description
- Always use file-based body input (`--body-file`) for GitHub to avoid escaping issues
- If the update fails, still return the link and summary to the user, and append a note:
  "Note: PR title/description auto-update failed. You can manually update it with the content above."

### Step 5: Cleanup

After reading DIFF_FILE and STAT_FILE, clean up the temp files:

```bash
rm -f {DIFF_FILE} {STAT_FILE}
```

## Error Handling

| Error | Cause | Action |
|-------|-------|-------|
| "Not inside a git repository" | User not in a repo dir | Ask user to cd into their repo |
| "gh/glab CLI not installed" | Missing tool | Provide install instructions from Prerequisites |
| "gh/glab CLI not authenticated" | Not logged in | Guide user through auth login |
| "No origin remote detected" | No remote configured | Ask user to add remote |
| "Cannot detect default branch" | No main/master found | Ask user to specify with --target |
| "Push failed" | Auth or network issue | Check keys and connectivity |
| "No changes detected" | Clean working tree | Inform user nothing to submit |
| "PR title/description update failed" | Network/permission | Return link + summary, suggest manual paste |

On any script failure, the script auto-rolls-back the temporary branch. No manual cleanup needed.
