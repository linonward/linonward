# Git Workflow

Follow this workflow for every repository change.

## Before Starting

1. Run `git status --short --branch` and inspect the current branch and working tree.
2. Keep the primary `linonward` checkout on `main`. Never edit or commit feature work there.
3. Treat existing changes as user-owned. Do not discard, overwrite, stage, or include unrelated
   changes in a commit.
4. Pull or rebase only when explicitly requested. Never assume network operations are desired.
5. Create a sibling worktree for the task before editing files. Use one of these branch prefixes:
   - `feat/` for new behavior
   - `fix/` for bug fixes
   - `refactor/` for internal restructuring
   - `docs/` for documentation-only changes
   - `chore/` for tooling and maintenance

Use short, lowercase, hyphen-separated branch names, for example `feat/add-api-workspace`.

## Worktree-First Development

Use a Git worktree for development by default. The primary checkout is reserved for keeping `main`
synchronized and managing worktrees.

- Place each worktree next to the primary project directory.
- Name the worktree `linonward-<feat>-branch`.
- Use a lowercase, hyphen-separated task slug for `<feat>`, without the branch type prefix.
- Use the normal Conventional Commit type as the Git branch prefix.

For example, create branch `feat/add-api-workspace` in sibling directory
`../linonward-add-api-workspace-branch`:

```sh
git switch main
git pull --ff-only origin main
git worktree add ../linonward-add-api-workspace-branch -b feat/add-api-workspace main
```

Run all edits, validation, commits, and pushes from the task worktree. Before creating it, confirm
that the target path and branch do not already exist. Use `git worktree list` to inspect active
worktrees. Do not reuse one worktree for unrelated tasks.

## While Working

- Keep changes small and scoped to the current task.
- Check `git diff` regularly and investigate unexpected modifications immediately.
- Do not edit generated output such as `dist/`, `.turbo/`, or `node_modules/`.
- Do not use destructive commands such as `git reset --hard`, `git clean -fd`, or forced checkout.
- Do not rewrite published history or force-push unless the user explicitly requests it.
- Never push directly to `main`; all changes must reach `main` through a pull request.
- Resolve conflicts deliberately. Never choose one side wholesale without reviewing both versions.

## Validation

Before committing:

1. Run the narrowest checks relevant to the change.
2. Run `pnpm check` for repository-wide code or configuration changes.
3. Run `pnpm install --frozen-lockfile` when dependency metadata or the lockfile changes.
4. Run `git diff --check` to catch whitespace errors.
5. Review both `git diff` and `git diff --staged` before creating the commit.

Documentation-only changes may skip code checks when they cannot affect runtime or tooling behavior.

## Staging and Commits

- Stage only files that belong to the requested change. Prefer explicit paths over `git add .` when
  unrelated work exists.
- Follow Conventional Commits:

  ```text
  <type>(optional-scope): <imperative summary>
  ```

- Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and `chore`.
- Keep the subject concise, lowercase, and free of a trailing period.
- Use the commit body to explain motivation, tradeoffs, or migration steps when needed.
- Let Husky, lint-staged, and commitlint run normally. Never use `--no-verify` unless the user
  explicitly requests bypassing hooks.
- Do not amend, squash, or create fixup commits unless requested.

## Synchronizing Changes

- Prefer a clean working tree before rebasing or merging.
- Fetch before comparing local work with a remote branch.
- Rebase local, unpublished work when a linear history is desired; merge when repository policy or
  the user requires it.
- After resolving a rebase or merge, rerun the relevant validation because the combined result may
  differ from either side.
- Never push, publish a branch, or open a pull request unless the user asks.

## Pull Requests

Every change must be merged through a pull request. Direct commits and direct pushes to `main` are
prohibited.

When preparing a pull request:

1. Confirm the branch contains only the intended commits.
2. Summarize the outcome and motivation, not just the edited files.
3. Include the validation commands and their results.
4. Call out migrations, compatibility concerns, follow-up work, or known limitations.
5. Do not claim checks passed unless they were actually run successfully.
6. Do not merge the pull request unless the user explicitly requests it.

## After a Pull Request Is Merged

After confirming that a pull request was merged successfully, run cleanup from the primary
`linonward` checkout, not from the task worktree:

1. Remember the merged topic branch name and its worktree path.
2. Confirm the primary checkout is on `main` with `git switch main`.
3. Synchronize it using `git pull --ff-only origin main`. Never create a local merge commit while
   updating `main`.
4. Confirm that local `main` matches `origin/main` and includes the merged pull request.
5. Confirm the task worktree is clean, then remove it with
   `git worktree remove ../linonward-<feat>-branch`.
6. Delete a normally merged topic branch with `git branch -d <branch>`. After a squash merge, Git
   does not consider the original branch tip merged; only after verifying the PR is merged and the
   synchronized `main` contains its squash commit, delete it with `git branch -D <branch>`. Never
   use `-D` before those checks.
7. If the remote topic branch still exists, delete it with `git push origin --delete <branch>`.
8. Run `git worktree list` and verify the primary working tree is clean. Create a new sibling
   worktree before starting any further change.

## Completion

Report the final branch, commit hash when applicable, validation performed, and whether the working
tree still contains uncommitted changes.
