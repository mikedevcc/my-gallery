# JSON request limits

Every JSON-consuming API mutation uses `scripts/bounded-json.ts`, through
`jsonObject` or the conflict route's object validation. The multipart upload route
retains its separate streaming upload limits; GET/HEAD routes do not parse JSON.

| Endpoints/methods | Profile |
| --- | --- |
| POST `/api/albums`, `/api/trips`; PATCH `/api/albums/:id`, `/api/trips/:id`, `/api/media/:id` | Single object |
| POST/DELETE `/api/albums/:id/media`; DELETE `/api/trips/:id/media`; POST `/api/import/conflict` | Single object |
| POST/PATCH `/api/trips/:id/media`; PATCH `/api/albums/:id/media` | Bulk object |

## Configuration

Startup validates these settings; readers validate them again at usage. Restart the
service after changing configuration. Values must be positive decimal integers;
empty, zero, fractional and out-of-range values fail configuration validation.

| Variable | Default | Hard ceiling |
| --- | ---: | ---: |
| `API_JSON_MAX_BYTES` | 4096 (4 KiB), single profile | 1048576 (1 MiB) |
| `API_JSON_BULK_MAX_BYTES` | 65536 (64 KiB), bulk profile | 1048576 (1 MiB) |
| `API_JSON_TIMEOUT_MS` | 10000 (10 seconds), total deadline | 60000 |
| `API_JSON_MAX_IDS` | 500 per bulk `mediaIds` array | 10000 |
| `API_JSON_MAX_DEPTH` | 4, root depth 0; a direct property has depth 1 | 16 |
| `API_JSON_MAX_NODES` | 2048, counting root, containers and values | 100000 |

Arrays outside a bulk object's top-level `mediaIds` field are limited to 32
entries, including arrays in unknown fields. Depth/node/byte limits apply to all
fields, including nested or ignored fields. Configured limits are independent:
increasing IDs alone does not increase the byte or node budgets. ID count is also
checked by `collectionIds` before database checkout/transaction work. Existing
integer, uniqueness, collection-name, action and DTO validation remains in place;
requests are completely read and validated before any mutation begins. Transaction
semantics and response DTOs are unchanged. A selection over the limit must be
reduced explicitly; the server does not silently split transactions into batches.

## Behavior and deployment

The reader counts bytes while consuming the stream even when Content-Length is
absent or understated. An oversized declared length is rejected before reading;
a malformed Content-Length returns 400. Bodies exceeding the selected byte cap,
array count or node budget return 413. Malformed JSON, invalid UTF-8, non-object
DTOs, invalid field values and excessive depth return 400. Cancellation and the
single total deadline return 408. Internal stream errors return a generic 400.
No raw body, parsing exception or supplied secret is returned to clients.

A fixed buffer bounds retained input independently of chunk count. The deadline
covers body consumption, decoding, parsing and structural checks; a slow trickle
does not extend it. Abort/timeout cancels the reader and releases its lock without
waiting indefinitely for an upstream cancel hook. Native `JSON.parse` is synchronous
and cannot be forcibly preempted; byte ceilings bound its input and elapsed time
is checked immediately afterwards. Parsed objects/strings and framework buffers
add memory beyond the byte buffer. These are per-request limits, not global
admission or memory quotas; keep the deployment access boundary and OS limits.

Use reverse-proxy route-specific JSON body caps and body-read/response timeouts.
Keep `/api/import` multipart's larger upload allowance separate; do not apply its
512 MiB upload budget as the JSON policy. Permit at least the application's selected
byte cap for each JSON route (use an explicit byte count when matching exact caps).
Disable or separately bound proxy request buffering and temporary storage. A proxy
may reject earlier with its own response format; the application cannot constrain
bytes already buffered by the proxy/framework or undo a completed database commit
if the connection is lost afterwards. JSON deadlines end before database work and
do not impose database query or transaction timeouts.
