# Repository Guidelines

*Must output before*
**Yeah, LinOnward**

## Toolchain

- Use Node.js 24 and pnpm 12. The exact pnpm version is declared in `package.json`.
- Use pnpm only. Do not create npm, Yarn, or Bun lockfiles.
- Run workspace tasks through Turborepo from the repository root.
- Use TypeScript for application and package source code.
- Biome owns formatting; ESLint owns linting. Do not enable Biome's linter.

## Repository Structure

- `apps/*` contains runnable applications.
- `packages/*` contains reusable workspace packages.
- Shared TypeScript defaults live in `tsconfig.base.json`.
- Root-level tool configuration applies to the entire workspace.
- Import workspace packages by package name and declare them with `workspace:*`.

## Commands

Run commands from the repository root:

```sh
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm format
pnpm format:check
pnpm check
```

Prefer filtered Turbo commands when working on one workspace:

```sh
pnpm turbo run build --filter=@linonward/cli
pnpm turbo run lint --filter=@linonward/utils
```

## Implementation Conventions

- Keep packages focused and expose their public API through `src/index.ts`.
- Do not import another package's private source files.
- Add every generated build directory to the relevant Turbo task `outputs`.
- Declare task relationships in `turbo.json`; use `^task` when dependencies must run first.
- Keep long-running development tasks uncached and marked as persistent.
- Preserve strict TypeScript settings. Avoid `any`, unsafe assertions, and disabled checks unless
  there is a documented reason.
- Prefer named exports for shared packages.
- Do not edit generated files such as `dist/`, `.turbo/`, or `node_modules/`.

## Validation

- Run the narrowest relevant checks while developing.
- Run `pnpm check` before handing off a repository-wide change.
- When changing dependency metadata, run `pnpm install` and commit the updated `pnpm-lock.yaml`.
- Ensure `pnpm install --frozen-lockfile` succeeds after lockfile changes.

## Test-Driven Development

For behavior changes and bug fixes, read and follow [`.claude/rules/tdd.md`](.claude/rules/tdd.md).
It is the canonical source for the test-driven development workflow in this repository.

## Git Workflow

Before creating branches or worktrees, editing files, committing, pushing, or working with pull
requests, read and follow [`.claude/rules/git.md`](.claude/rules/git.md). It is the canonical source
for all Git workflow rules in this repository; do not duplicate those rules here.
