# Trip and Album integrity (M5/M6)

Trip Add accepts only media with NULL trip_id. Adding media already in **any**
Trip, including the requested target, returns HTTP 409 with the conflicting
`mediaIds`; use explicit Move to change membership. Missing media/collections
return 404, invalid/duplicate IDs or identical source/target return 400. Existing
single-file POST `{ "mediaId": 1 }` remains supported; Trip POST also accepts
`{ "mediaIds": [1, 2] }`. The Trip picker submits one bulk request, rather than
committing individual selected files separately. A bulk selection commits completely
or rolls back.
Trip Move retains its conditional source-trip check and all-or-nothing behavior.
Trip rows are locked in ascending order before media rows, preserving compatibility
with Trip deletion's existing ON DELETE SET NULL behavior.

Album copying/moving validates every selected source membership while both Albums
are locked. A stale selection returns 409 without copying or removing a subset.
Copy `affectedCount` is the number of **new target memberships**; already-present
members count zero. Move counts **members removed from the source**, including
those already present in the target. Add returns `addedCount` (zero for a duplicate
Album membership). No Album operation deletes a media record. Deleting an Album
uses the existing FK cascade to remove only its join rows.

Successful mutations repair a NULL or nonmember cover by choosing MIN(media_id)
from the Album's current members, or NULL if empty. An existing valid custom cover
is preserved. Media deletion locks affected Albums, cascades media memberships,
repairs covers and inserts its deletion receipt within the **same transaction**.
Receipt, storage-validation, destination-lock and filesystem recovery behavior is
preserved; a receipt failure rolls the collection changes back too.

## Lock protocol

Album membership/cover writers and Album deletion take the shared transaction
advisory lock `(1296514892, 6)`, then affected Album rows in ascending order, then
media KEY SHARE references. The weaker media lock is intentional: it is compatible
with foreign-key reference checks during cover reassignment. Taking exclusive
media rows before Album rows can deadlock concurrent cover changes.

Media deletion takes the exclusive form of that advisory lock before locking its
media and affected Albums. This stabilizes membership discovery, including new
Album memberships, without optimistic retry loops or additional tables. All
locks are PostgreSQL transaction locks and release on commit, rollback or backend
termination; they work across Node processes. This two-integer advisory namespace
is distinct from the existing bigint operation-receipt advisory namespace.

Independent Album edits share the advisory guard and remain concurrent when their
row sets do not overlap. Media-deletion transactions serialize against Album
mutations and other media deletions, including their existing pre-commit storage
identity verification; a slow HDD can extend that wait. Filesystem publication,
cleanup and unrelated Trip operations retain their existing protocols. Do not
hold one collection transaction while starting another.

The protocol applies to the application writers in this repository. Manual SQL,
old application processes or external writers that bypass it can still create
invalid covers: the current FK checks cover media existence, not membership.
Restart/drain old writers when deploying. No automatic sweep of pre-existing bad
covers is performed; an affected Album is repaired when successfully mutated.
No schema migration or applied-migration edit is required.

## Tests

The ordinary suite mocks Pool checkout and injects a failure at every query to
verify rollback/client release. PostgreSQL integration tests are opt-in:

```bash
COLLECTION_PG_FIXTURE=/tmp/gallery-collections-EXAMPLE/fixture.json \
  node --import tsx --test scripts/collections-postgres.test.ts
```

This is a **placeholder**, not a provisioning command. Provision a new private
PostgreSQL 17 cluster separately, with TCP disabled and a private Unix socket at
`<fixture-root>/socket`, port 55439, role `collection_test`, and database
`gallery_collections_test`. Populate only this disposable database with schema
fixtures from 0001–0003. Metadata must contain `root`, `directory` (`<root>/data`),
`socket`, `url` (percent-encoded Unix-socket host), and the server's
`pg_postmaster_start_time()::text` as `started`; store it as a regular 0600 JSON
file under a service-user-owned 0700 `/tmp/gallery-collections-*` directory.

The test guard refuses other targets and verifies database, role, data directory,
PostgreSQL version and server start time before each SQL write. ROLLBACK is allowed
on the same previously verified connection after an aborted SQL transaction.
The integration suite resets **all fixture tables**; never supply a real database
or reuse a shared fixture concurrently. It performs no filesystem media operations
and does not connect to the existing gallery server. Storage callbacks are mocks;
end-to-end HDD/recovery behavior remains covered by its separate regression suites.
