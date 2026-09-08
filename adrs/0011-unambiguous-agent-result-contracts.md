# ADR-0011: Keep executable proposals separate from reports

## Status

Accepted; refines the result contracts in ADR-0008 and ADR-0009.

## Context

Real native runs produced correct code but spent another 29 seconds repairing executor validation strings containing parenthetical pass reports. Another spent 32 seconds repairing a documentation proof reference that cited a passing typecheck instead of the diff. These are protocol costs, not code defects.

## Decision

Direct executors propose additionalChecks objects with command and optional reason, rather than an ambiguous validation report array. Configured checks remain harness-owned and mandatory. Reports belong in summary. Routing owns one contract shared by execution and artifact repair, and normalizes proposals into canonical task validation. Legacy validation string arrays remain readable when additionalChecks is absent. When both exist, the new field wins.

Never strip prose from executable strings. Validate shape, count, shell syntax and meaningful acceptance checks before running proposals. A completed result still needs checks, whether configured or proposed.

Documentation coverage always binds to the candidate diff. The reviewer still independently determines whether documentation satisfies the requirement; the harness supplies the only relevant artifact identity. Ignore legacy documentation evidence references. Behavioral and structural references retain explicit identity validation; behavior still requires passing assertion evidence.

## Consequences and validation

No new model phase, retry policy or state store. Existing one-shot guarded artifact repair handles malformed output. Contract tests cover structured and legacy forms, precedence, missing checks and invalid commands. CLI tests execute structured proposals with a non-executable reason. Captured documentation output replays deterministically, and live correct/stale documentation cases establish that automatic binding does not automatically approve stale documentation.
