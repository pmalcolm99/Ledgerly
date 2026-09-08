// The default per-test database isolation mode (task 2.12, D-18). A
// package wires this up by pointing at it from `test.setupFiles` in its own
// vitest.config.ts — see packages/db/vitest.config.ts for the reference.
//
// This registers a transaction opened in `beforeEach` and always rolled
// back in `afterEach`, so a test that inserts leaves the database unchanged
// after the run. It requires TEST_DATABASE_URL and refuses to run against
// DATABASE_URL — see packages/db/src/testHarness.ts.
//
// Some tests need genuinely concurrent, separately-connected transactions
// instead (Phase 3's first-owner race, task 3.4). That escape hatch is
// `withCleanDatabase()` in the same module — imported and called directly
// by the tests that need it, not wired up here.
import { registerRollbackHooks } from "../packages/db/src/testHarness";

registerRollbackHooks();
