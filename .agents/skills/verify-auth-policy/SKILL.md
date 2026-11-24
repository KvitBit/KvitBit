---
name: verify-auth-policy
description: Exhaustively check the core permission policy (`can`, `authorizeInWorkspace`, `checkMembershipChange`) against the role × action table of core-ports 2.3. Use before merging any change to packages/core/src/policy/**, the `Action`, `Role`, `Caller` or scope definitions in packages/domain/src, the System caller seal in packages/core/src/internal/system.ts, or the policy table in docs/design/core-ports.md.
---

# Verify the auth policy

**Property.** For every caller kind, role, Action and credential scope set in the bounds below, `can` grants exactly what the core-ports 2.3 table grants that role, narrowed by the scopes (rule R1), Workspace-scoped methods only ever run in the caller's own Workspace and a record of another Workspace is `NotFound` (R2), and membership changes obey R1c and R3.

**Harm.** A wrong cell lets a token, a role, a workflow or an anonymous visitor read or change another person's invoices, credentials or membership, or locks a legitimate user out.

This is exhaustive finite enumeration of the real code, not sampling: every element of each domain below is checked, and each domain's size is asserted so a shrinking domain fails the run.

## Does my change touch it?

Covered files and guarded symbols:

- `packages/core/src/policy/can.ts`: `can`, `scopesAllow`, `actionScope`
- `packages/core/src/policy/table.ts`: `POLICY`
- `packages/core/src/policy/Policy.ts`: `authorize`, `authorizeInWorkspace`
- `packages/core/src/policy/membership.ts`: `checkMembershipChange`
- `packages/core/src/internal/system.ts`: `systemCaller`, `isSealedSystem`
- `packages/domain/src/action.ts` (`Action`), `packages/domain/src/scope.ts` (`SCOPE_AREAS`, `Scope`), `packages/domain/src/caller.ts` (`Caller`, `SystemJob`), `packages/domain/src/vocabulary.ts` (`Role`)
- Through the existing example tests in the same command: `packages/core/src/store/**` Workspace-scoped repository reads and writes (`test/store.test.ts`, "another Workspace's row is NotFound for every operation") and `packages/core/src/modules/contacts/live.ts` (`test/modules/contacts/contacts.test.ts`, "another Workspace's Contact is NotFound for get, save and archive", next to the own-Workspace cases). These are example tests, not enumeration.
- Oracle source: `docs/design/core-ports.md` lines 157-300 (2.1 Caller, 2.3 table rows 274-287, rules R1-R5) and the MCP tool scope column in `docs/design/http-mcp-contracts.md` lines 1319-1346.

If `git diff 77a5bb7 -- <those paths>` is non-empty, run the check.

## Run

```sh
bun test --cwd packages/core ./test/policy/can.property.test.ts ./test/store.test.ts ./test/modules/contacts/contacts.test.ts
```

Passes in about 4 seconds (71 tests, 1 skipped: the wide bound). A `CoreStore.afterCommit failed` log line is an expected store test, not a failure.

Wide bound (nightly, and every time you move the sync commit), about 50 seconds:

```sh
KVITBIT_FORMAL_WIDE=1 bun test --cwd packages/core ./test/policy/can.property.test.ts -t wide
``` Tool: bun 1.4.2 (root `packageManager`; also confirmed on bun 1.4.4), effect 4.1.4. `bun run test` runs it with the rest of `@kvitbit/core`.

The repo-wide coverage record is `formal/manifest.json`, kept centrally; `bun run verify:formal --check-digests` reports checks whose covered files changed since they were last confirmed. Update this skill's entry there when you move the sync commit.

## Bounds (exact counts, asserted in the test)

- 54 Actions, 4 roles, 10 scope areas, 20 scopes, 4 System jobs, 5 Caller kinds. Roles and jobs are compared with the `Role` and `SystemJob` schemas, and the Caller kinds with a compile-checked record of `Caller["_tag"]`, so a new role, job or caller kind fails the run (or typecheck) until the enumeration covers it.
- `actionScope` equals the spec's area and level for each of the 39 Actions that scopes narrow (session-only and edge-holder Actions ignore scopes).
- Member, normalized grants: every role × every grant where each area is none, read, or read and write (3^10 = 59,049) plus the session (`"all"`) × every Action: 12,754,800 `can` calls. Also checks that raising one area by one level never removes an Action and that no grant exceeds its role's session.
- Member, raw scope lists: every role × every pair of areas (45) × all 16 raw states of the pair (none, read, write only, both; listed write first) × every Action: 155,520 calls. In the default run this is the only domain that catches a lost write ⇒ read rule, since normalized grants always carry the read.
- Wide (`KVITBIT_FORMAL_WIDE=1`): every role × every raw scope list, each area none, read, write only, or both (4^10 = 1,048,576 lists) × every Action: 226,492,416 `can` calls. This covers every scope combination; passed at the sync commit.
- Non-Member callers: Account, ShareLinkVisitor (with and without `signedInUser`), InvitationHolder, sealed System for each of the 4 jobs, and an unsealed spread copy of each (12 callers) × every Action.
- `authorizeInWorkspace`: 44 callers (each role with session, all twenty scopes and no scopes, each System job, in Workspace A and B, plus the 12 above) × every Action.
- `checkMembershipChange`: 36 callers (each role × 6 scope sets, plus the 12 above) × 25 changes (Leave, Invite × 4, Remove × 4, SetRole × 16); a denial must carry the right tag, `Forbidden.action`, `Conflict.reason` (`illegal_transition`) and detail.

## Assumptions and what is not covered

- `can` ignores caller fields other than `_tag`, `role`, `scopes` and the System `job` and seal; locale, channel, client and IDs take one value each.
- The scope area of actions that the MCP table does not list comes from R1's area for the action's noun (`member`/`invitation` → `members`, `schedule` → `templates`, `priceList` → `catalog`), and the level from the table row (row 274 and `invitation.read` read, every other Workspace row writes). If the spec ever states a different area, update the oracle's `AREA_OF_NOUN`.
- A raw write-only token is treated as holding read (core-ports.md:171 states write implies read at grant time; the oracle applies it at check time too).
- When a membership change both touches the owner and needs `member.manageAdmins`, the spec does not fix which error comes first; the test accepts either `Conflict` or `Forbidden{member.manageAdmins}`.
- The default run covers raw lists over at most two areas plus every normalized grant; raw lists over three or more areas are covered only by the wide run. Raw lists are in canonical order in the wide run; order and duplicates are varied only in the two-area domain.
- R2 (a foreign record is `NotFound`) lives in the store queries. The enumeration proves the policy hands every module the caller's own `workspaceId`; the store and Contacts example tests show a foreign row is `NotFound`. Other modules' use of that `workspaceId` is not covered here. Edge caps (accountant read-only grants, `Workspaces.enter` membership lookup) are outside it.

## Drift or bug?

A failure prints up to five `role [scopes] action: can=…` lines (or `expected …, got …`).

1. Read the failing Action's row in `docs/design/core-ports.md` 2.3 and the rule it cites.
2. If the code disagrees with the spec, it is a real bug: report it with the counterexample in those words and the `table.ts` or `can.ts` line; do not edit the oracle to match.
3. If the spec changed on purpose (a new Action, a moved cell), update the oracle `SPEC` rows with the new line numbers and the domain-size assertions, and say so in the PR.
4. A size assertion failing alone means a domain changed (new Action, area or job); extend the oracle before trusting a pass.

## Update

When the policy or the spec changes on purpose: edit `SPEC`, `AREA_OF_NOUN`, `READS` or `isSessionOnly` in `packages/core/test/policy/can.property.test.ts` from the spec text, never from `table.ts`; update the asserted counts; run the check; break the change once (for example grant `contact.write` to `accountant` in `table.ts`) to see it fail; revert; then move the sync commit below.

## Coverage record

- Sync commit: `77a5bb7` (verification confirmed to describe the covered files at this commit).
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green:
  - `table.ts`: `contact.write` granted to every role → 2 tests fail (`accountant ["contacts:write"] contact.write: can=true`).
  - `can.ts` `scopesAllow`: write no longer covers read → raw-list test fails (`owner ["members:write"] member.read: can=false`).
  - `Policy.ts`: `authorizeInWorkspace` returns Workspace A for every caller → fails (`Member workspace.read: scoped to …a001`).
  - `membership.ts`: owner target no longer refused → fails (`Member owner "all" {"_tag":"Remove","targetRole":"owner"}: expected Conflict:, got ok`).
  - `membership.ts`: `Conflict.reason` `illegal_transition` changed to `duplicate` → fails (`… {"_tag":"Invite","role":"owner"}: expected Conflict:illegal_transition:, got Conflict:duplicate:`).
  - `packages/domain/src/caller.ts`: a fifth `SystemJob` (`Purge`) added → the domain-size test fails.
