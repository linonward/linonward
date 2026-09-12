# Test-Driven Development

Use test-driven development for behavior changes and bug fixes.

## Red, Green, Refactor

1. **Red:** Write the smallest test that describes the intended behavior or reproduces the bug.
2. Run the narrowest relevant test command and confirm the new test fails for the expected reason.
3. **Green:** Make the smallest production-code change that makes the test pass.
4. Rerun the focused test and confirm it passes.
5. **Refactor:** Improve the implementation and tests without changing behavior, keeping the focused
   test green throughout.

Do not write production code for new behavior before establishing the failing test. If a test cannot
be written first, document the reason before implementing the change and add the closest practical
automated coverage afterward.

## Test Design

- Test observable behavior through public interfaces rather than implementation details.
- Keep each test focused on one behavior and give it a name that states the expected outcome.
- Cover the happy path, relevant boundary conditions, and failure modes introduced by the change.
- Add a regression test for every bug fix. Confirm that it fails before the fix and passes afterward.
- Prefer deterministic tests. Control time, randomness, network access, and other external state.
- Use test doubles only at system boundaries; avoid mocking the unit under test or its internal
  collaborators unnecessarily.
- Keep fixtures small, explicit, and local unless several tests genuinely share the same setup.
- Do not weaken, skip, delete, or rewrite an existing test merely to make a change pass unless the
  product behavior has intentionally changed.

## Scope and Commands

- Place tests next to the workspace and source they exercise, following that workspace's existing
  naming and organization conventions.
- Use the repository's existing test framework and dependencies. Do not add a new test library when
  the current tooling can express the test.
- Run workspace tasks from the repository root through Turborepo. During the cycle, prefer the
  narrowest applicable command, for example:

  ```sh
  pnpm turbo run test --filter=<workspace>
  ```

- Before handing off, run all tests affected by the change. Run `pnpm check` for repository-wide
  code or configuration changes, as required by the repository guidelines.

## Completion Evidence

Report the test added or changed, the observed red failure, the passing command after implementation,
and any behavior that remains untested with the reason.
