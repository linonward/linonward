# Repository structure

- Top-level layout: apps, packages, scripts, and root configuration.
- Each package exposes its public API through `src/index.ts`.

# Configuration

- `package.json` pins the toolchain and scripts.
- `tsconfig.base.json` owns the shared strict TypeScript defaults.

# Quality gates

- Lint, typecheck, and test must all be runnable offline.
- Validation evidence must bind the current mutation revision.

# Risks

- Generated directories (`dist`, `build`, `.next`) must never be edited.
- Secrets must stay outside the repository and outside tool output.
