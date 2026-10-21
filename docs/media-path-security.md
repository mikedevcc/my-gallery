# Media destination and private-namespace rules (M14)

All request-facing names are validated before path construction. Filenames and
city/year directory segments must be nonempty single Linux path components: no
`.`/`..`, slash/backslash, control characters, bidi override/isolate controls,
unpaired UTF-16 surrogates, whitespace-only names, or more than 255 UTF-8 bytes.
Directory components cannot start with a dot. Filename spelling, case, spaces,
Unicode composition, emoji and accents are preserved; names are never trimmed,
URL-decoded, normalized, sanitized with basename(), or renamed into acceptance.
Literal percent escapes and Unicode slash lookalikes are ordinary characters,
not separators; no later filesystem step decodes them. Linux names such as
CON.jpg remain valid; Windows-specific device-name rules are not imposed.

Originals cannot use any component named `.incoming`, `.destination-locks`,
`.replacement-operations`, `.deletion-operations`, `.thumbnails`,
`.resolution-lock`, `.conflict.json`, or `.mygallery-storage.json` (comparison is
case-insensitive for these private names). Generated `.backup-UUID`,
`.publish-UUID` suffixes and `.owner-UUID.tmp` names are reserved. Internal helpers
still use these names deliberately, with validated UUIDs or positive safe integer
media IDs; originals cannot enter them through an alternate API or stored path.

## Audited boundaries

| Inputs/writers | Checks |
| --- | --- |
| Upload `File.name` / `stageMediaFile` | Snapshot and validate name before creating `.incoming` or a UUID job; exclusive stream creation remains unchanged. |
| `buildDestinationPath` | Validate the filename, year and geocoder city separately before joining; missing year/city retain `Unknown`. Country names go only to parameterized SQL, never a path. |
| `processStagedMedia`, cleanup, conflict metadata and marker claims | Require `.incoming/<UUID>/<validated filename>`; recorded destinations are checked before metadata/marker creation. An arbitrary input cannot cause recursive cleanup of the storage root or another job. |
| Finalization, replacement, deletion and thumbnail generation | Destination locks validate original paths both lexically and after canonical parent resolution, before creating lock artifacts or calling metadata mutations. Revalidation repeats these checks. |
| Storage directories / internal readers and writers | Existing mount/installation checks remain. Symlink aliases into or out of private namespaces are refused, including private paths aliased to ordinary folders. |
| Replacement/deletion journal readers | Validate original destination namespace before recovery can claim a lock; normal recovery states, receipt rules and ownership checks remain unchanged. |
| Backups/publication files | Names are derived from a validated target plus operation UUID; check component length before journal handoff or file publication. |
| Thumbnail cache paths | Validate positive safe integer media IDs before generating cache filenames, creating locks or removing cache entries. Cache lookup deliberately uses the private namespace, not the original-destination helper. |
| Original streaming and conflict previews | Apply the same original/staging namespace rules and retain H5's MIME, no-follow descriptor pinning, race checks, cancellation and Range behavior. Invalid path selections yield the existing safe 404 response. |
| Job IDs, country metadata and display filenames | Job labels/country values are data, not filesystem components. Display filenames remain handled by existing HTTP-header encoding. Client-side validation is not a security boundary. |
| Development import scripts | Read their explicitly selected local source files and submit `File` objects through normal server staging. They are not public filesystem endpoints; M14 does not run these scripts or change their source paths. |

## Canonical paths and compatibility

Original paths must be absolute, normalized and strictly inside MEDIA_STORAGE_ROOT.
Validate the raw spelling before resolving: embedded `..`, redundant separators
or dot components cannot disappear into an otherwise acceptable path. Both the
supplied and canonical names must be public media paths. A public-looking symlink
cannot redirect into staging, journals, locks, caches or an outside filesystem.
Ordinary in-root parent aliases retain the existing shared destination-lock key;
H5's stricter no-alias serving checks remain unchanged. Symlink leaves remain
forbidden. The existing HDD identity, same-filesystem and mount revalidation rules
still apply during each operation.

No database records, existing media, journals or applied migrations are rewritten.
Existing legitimate paths, year/city layout, KEEP_BOTH naming and Unicode spelling
remain unchanged. Historical paths containing now-disallowed controls, backslashes,
private/hidden directory components, noncanonical spelling or reserved names fail
closed and require operator review; there is no automatic rename or migration.
Review an affected retained journal and its identities with writers stopped rather
than editing evidence or deleting locks to bypass validation.

Long existing filenames remain readable/deletable when otherwise valid. A
replacement suffix or KEEP_BOTH suffix can exceed the filesystem's 255-byte
component limit even when the original name is valid. Such operations fail before
publication/metadata mutation; M14 neither truncates nor changes stored names.
Extension/type validation remains separate and unchanged.

These checks assume the documented local Linux filesystem, correct fsync/mount
behavior, restricted service-account permissions and cooperating writers. Node's
path-based mutation syscalls are not an openat2 sandbox: a privileged,
nonparticipating process changing directories between checks and syscalls remains
outside the protocol. Keep the media tree unwritable by unrelated accounts.

Tests use temporary files, mocked mount probes and database callbacks. The offline
suite exercises malicious upload/geocoder values, reserved destinations and alias
escapes, invalid thumbnail IDs, import cleanup, long-name failures, Unicode names,
and existing H4/M1/N1 recovery and streaming regressions. No real media, database
connections or migration execution are needed for M14 verification.
