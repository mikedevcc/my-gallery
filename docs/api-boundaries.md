# API validation and public data (M3/M4)

Collection creation, renaming, membership mutations and favorites validate JSON
before database checkout. Bodies must be non-null JSON objects, not arrays or
scalars. Expected fields have explicit types; IDs in JSON are numbers, not numeric
strings/booleans. Path IDs use canonical positive decimal notation. All IDs fit
PostgreSQL integer range 1–2147483647; exponent/hex/decimal path forms, zero,
negatives, fractions and overflow are rejected. Bulk selections validate every
ID and reject duplicates/empty arrays before beginning a transaction.

Album/Trip names must be strings, are trimmed as before, and contain 1–100 Unicode
code points, matching PostgreSQL varchar(100). Exactly 100 characters is valid
for both creation and rename. NUL and unpaired UTF-16 surrogates are rejected.
Unknown extra request keys have no effect; request objects are never spread into
SQL parameters. Malformed bodies/types/IDs return 400. Genuine stale membership
and uniqueness/foreign-key conflicts return 409. Resource-size/type/deadline
statuses (413/415/408/422/503/504/507) retain the M13 policy. Missing resources
return 404. M5/M6 transactional all-or-nothing behavior is unchanged.

## Public payloads

All collection and media JSON reads project rows through explicit field allowlists.
They expose UI metadata and media/collection IDs, not original filesystem `path`,
mount/installation identities, credentials, future internal columns or whole DB
objects. SQL row types retain paths internally for filesystem/recovery operations.
Original media still uses the existing ID-based streaming route; files are not
renamed, rewritten or reselected by the DTO layer.

Public import filename conflicts contain `type`, `jobId`, `conflictId`, optional
`existingMediaId`, and `existingFilename` only. Hash conflicts retain their type,
opaque IDs and existing media ID. The modal uses the filename plus existing
ID-based previews, without displaying server directory labels. Successful
resolution returns only `type` and, when completed, `mediaId`.

Internal `ImportConflict`, pending `.conflict.json` files, ownership markers and
recovery journals retain their full path evidence. Projection never mutates stored
evidence. Deploy the backend and frontend assets together and refresh already-open
clients: the new `PublicImportConflict` contract deliberately removes
`existingPath` from HTTP responses. No filesystem/recovery format migration is
needed.

## Failures and diagnostics

API handlers catch internal failures and return generic public messages. HTTP
responses never serialize Error objects, SQL details, exception messages/causes,
stack traces, subprocess output, configuration values or filesystem paths.
Validation exceptions contain only developer-defined public messages, never
interpolated request values. Domain/resource exceptions preserve appropriate
statuses but their internal messages are not sent. Media GET/HEAD and preview
errors retain their streaming/header behavior; a failure after headers have been
sent terminates the body with a generic stream error instead of attempting a
second JSON response.

Structured server diagnostics record route context, a generated request ID,
exception category, bounded PostgreSQL/OS error codes, source-file basenames with
line/column locations, and bounded cause/aggregate chains. They do not dump raw messages/stacks, credentials, SQL parameters, request
bodies or environment values. Unexpected failure responses include X-Request-ID
for correlation; media-delivery error responses do too. Keep server logs restricted
and manage retention. CLI operator/recovery output is separate from these API
response boundaries.

## Verification and remaining boundaries

`node --import tsx --test scripts/api-safety.test.ts` runs mocked database and
fetch-boundary tests with temporary storage/mount fixtures. Invalid-input tests
assert zero checkouts; response/log tests inject paths, credentials, private
identities, SQL details and future columns. Pending-conflict tests verify persisted
evidence stays byte-for-byte unchanged. Media-stream tests cover generic failures
and descriptor cleanup. PostgreSQL integration suites remain explicit opt-ins.

This work adds no authentication or authorization model. Media bytes, filenames,
dates, collection names, EXIF-derived UI metadata and required opaque IDs remain
intentional public application data within the deployment's access-control layer.
Original downloads can contain embedded metadata; no content scrubbing is added.
Use the private-network/authenticated-proxy deployment assumptions. Direct SQL,
operator filesystem access, arbitrary user-supplied strings deliberately stored as
public names, framework/proxy errors outside these handlers and log access remain
separate trust boundaries. Existing upload/control request limits are unchanged;
this change does not introduce a new collection body-size quota.
