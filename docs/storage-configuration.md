# Media storage on Debian (H4-A.1)

Storage must be deliberately provisioned before gallery operations. There is no
default path, automatic root creation, marker initialization, or system-drive
fallback. Missing/incorrect storage makes media operations fail closed. The Next.js
server can still start and display metadata; a successful build or listening HTTP
port is not a storage readiness check.

## Required server environment

```dotenv
MEDIA_STORAGE_ROOT=/srv/gallery-disk/library
MEDIA_STORAGE_UUID=<the mounted HDD filesystem UUID>
MEDIA_STORAGE_ID=<a separately generated installation UUID>
```

Use actual UUID values, without angle brackets. Obtain the filesystem UUID with
administrator-reviewed `lsblk -f` / `findmnt` output. Generate a different random
installation UUID for each independent gallery. Set these in the service's
protected environment file (or Next.js server environment); do not use NEXT_PUBLIC
variables. CLI processes must receive the same settings. Do not change a UUID to
silence a failed check without independently identifying the device.

The root must be an absolute existing directory whose canonical path equals its
configured path; use the real mount path rather than symlinked root components.
The supported deployment is Linux with a separately mounted writable **ext4 or
XFS** block-device filesystem, visible through `/proc/self/mountinfo` and
`/dev/disk/by-uuid/`. Other filesystems, the system `/` mount, nested mounts beneath
the gallery root, and read-only storage are rejected. A nested mount is rejected
even if it uses the same device. FAT/exFAT, network mounts, and container/overlay
storage are not supported by this validation policy.

Staging, originals, backups, thumbnails and `.destination-locks` stay under the
same root/mount. Hard links and same-filesystem rename semantics are required.
Do not relocate `.incoming`, `.thumbnails` or `.destination-locks` using a nested
mount. Media-file symlinks and paths escaping the root are rejected. Existing
database paths are absolute: configure the existing mounted location to preserve
them, or plan a separate, explicitly reviewed relocation. This change moves no
files and rewrites no database paths.

## Initial provisioning — administrator action only

These are instructions, not actions performed by the application or this change.
Never format/initialize a disk as part of application startup or an upgrade.

1. Independently identify the intended HDD and its existing filesystem. Back up
   existing data. Pick a stable mountpoint, for example `/srv/gallery-disk`.
2. Configure mounting by filesystem UUID in `/etc/fstab`. Example only:

   ```fstab
   UUID=<HDD-filesystem-UUID> /srv/gallery-disk ext4 defaults,nodev,nosuid,nofail,x-systemd.device-timeout=10s 0 2
   ```

   Use the actual filesystem type and appropriate administrator-reviewed fsck
   settings (XFS differs). Do not substitute an unstable `/dev/sdX` device name.
3. Before creating anything below it, verify **both** that `/srv/gallery-disk` is
   a mountpoint and that `findmnt` reports the intended UUID/device/filesystem.
   Directory existence alone is insufficient. Never create `library` on the
   underlying system drive when the HDD is absent.
4. Provision an unprivileged `mygallery` service account. Create the gallery root
   on the verified HDD with permissions such as owner `mygallery`, mode `0700`.
   Its ancestors and the unmounted mountpoint must be administrator-owned and
   unwritable by that account. Inspect any pre-existing fallback directories;
   the application will not clean them up. Do not grant disk-group membership,
   raw block-device access, root privileges, or DAC-override capabilities.
5. Prepare and review this marker JSON, using the same UUIDs as the environment:

   ```json
   {
     "version": 1,
     "installationId": "<installation-UUID>",
     "filesystemUuid": "<HDD-filesystem-UUID>"
   }
   ```

   Manually install it as `library/.mygallery-storage.json`, for example owned
   by `root:mygallery`, mode `0440`. It must be a regular file, not a symlink.
   Never copy another installation's identity unintentionally or generate the
   marker automatically when a check fails. Retain its identity in backup records.
6. Only after verification may the application create internal directories. Its
   ordinary layout remains `.incoming`, `.thumbnails`, `.destination-locks`, and
   the existing year/location/original layout.

The marker protects against accidental wrong-volume/installation selection, not
a compromised process able to rewrite storage or environment configuration.

## systemd service requirements

Add mount ordering and an explicit mount assertion to the administrator's service.
Example fragment, using the example mountpoint above:

```ini
[Unit]
RequiresMountsFor=/srv/gallery-disk/library
BindsTo=srv-gallery\x2ddisk.mount
After=srv-gallery\x2ddisk.mount
AssertPathIsMountPoint=/srv/gallery-disk

[Service]
User=mygallery
Group=mygallery
EnvironmentFile=/etc/mygallery/environment
UMask=0077
NoNewPrivileges=true
```

Confirm the mount-unit name with `systemd-escape --path --suffix=mount`; change
the fragment for the actual mountpoint. Mount dependencies do not by themselves
prove UUID identity. The application also verifies it. The account must be able
to read mount metadata and stat the UUID's block-device node; it never opens the
block device. Sandboxing that hides this metadata (for example PrivateDevices)
needs separate review and must not be worked around by disabling validation.

The unmounted directory permissions are essential: path-based Node.js checks
cannot atomically stop an administrator unmounting a volume between a check and
a syscall. systemd dependency/lifecycle controls plus an unwritable system-drive
fallback prevent writes from being redirected there. Do not unmount or swap the
HDD while the service or other writers are running. USB removal/I/O failure can
still interrupt in-flight work; stop the service and investigate before resuming.

## Runtime behavior and recovery limits

There is no cached startup-only approval. Operations reread mount/device/marker
identity. Active destination locks pin the root inode, device and mount ID; a
remount cannot silently continue an old operation. Reads validate before and
after access, and mutation paths revalidate between asynchronous stages.

Media deletion checks storage before DELETE and again before COMMIT in the same
PostgreSQL transaction. Detected loss rolls the metadata transaction back and
retains an unresolved destination lock where applicable. There is no distributed
transaction between PostgreSQL and the HDD: removal after the final check/commit
can still leave committed metadata deletion and an orphaned original. Ambiguous
commit acknowledgement, power-loss durability, and automatic reconciliation
remain H4 recovery work. Do not claim a physical unplug can always be rolled back.

On validation failure, stop retries that mutate storage. Never initialize a new
marker, recreate the root, clear retained locks, or point the environment at a
different disk just to regain availability. Restore the expected mount, verify
identity and backups, then follow [destination-lock recovery](destination-locking.md).

## Offline tests

```bash
node --import tsx scripts/storage-safety.test.ts
node --import tsx scripts/destination-lock.test.ts
node --import tsx scripts/media-database.test.ts
```

Fixtures explicitly create their own markers under fresh temporary directories
and mock mount/device metadata. There is no production test-mode bypass. These
tests do not mount, format, or inspect a real HDD or connect to PostgreSQL. Verify
the actual deployment separately before enabling media writes.

For upload/destination component rules, private namespaces, symlink handling and
legacy-path compatibility, see [media path security](media-path-security.md).

For streaming-upload limits, processing admission, temporary-storage budgets and
Debian resource controls, see [processing limits](processing-limits.md).

## Explicit Docker mode (Debian 13)

Native mode remains the default (`MEDIA_STORAGE_MODE=native`) and still resolves
`/dev/disk/by-uuid/<UUID>` on every check. Docker mode is an explicit alternative:

```dotenv
MEDIA_STORAGE_MODE=docker
MEDIA_STORAGE_ROOT=/srv/gallery-media
MEDIA_STORAGE_UUID=<filesystem UUID>
MEDIA_STORAGE_ID=<installation UUID>
MEDIA_STORAGE_ASSERTION=/run/gallery-identity/identity.json
```

The media path **inside** the container must preserve existing absolute database
paths. Bind-mount the existing host media directory there. Docker mode requires a
host assertion; it never attempts device discovery inside the container. All the
normal ext4/XFS, writable media mount, symlink, marker, nested-path mount and
operation continuity checks remain active.

The host needs Python 3, util-linux `blkid`, `/proc/self/mountinfo`, UUID device
links, and sufficient host privileges to probe the actual block device. Run
`scripts/storage-preflight.py` on the host, never in the application container.
It probes `blkid -p` (no UUID cache), compares the block device's `st_rdev` to the
media root's `st_dev`, verifies the exact expected covering mountpoint and marker,
and publishes a bounded JSON assertion with atomic rename and fsync. It creates
neither media roots nor markers. Use canonical absolute host paths. The media
root may be a directory below the expected mountpoint, but cannot be covered by
another mount. The assertion directory must already exist outside that entire
USB mount, owned by the administrator and unwritable by the application or other
untrusted users. Serialize preflight and container lifecycle management.

Example Compose service fragment (merge with the actual image, database and
other required configuration):

```yaml
services:
  gallery:
    restart: "no"
    environment:
      MEDIA_STORAGE_MODE: docker
      MEDIA_STORAGE_ROOT: /srv/gallery-media
      MEDIA_STORAGE_UUID: ${MEDIA_STORAGE_UUID}
      MEDIA_STORAGE_ID: ${MEDIA_STORAGE_ID}
      MEDIA_STORAGE_ASSERTION: /run/gallery-identity/identity.json
    volumes:
      - type: bind
        source: /srv/gallery-disk/library
        target: /srv/gallery-media
        bind:
          create_host_path: false
      - type: bind
        source: /run/mygallery-identity
        target: /run/gallery-identity
        read_only: true
        bind:
          create_host_path: false
```

Mount the **assertion directory**, not an individual file: atomic replacement or
unlink must be visible in the container. The app requires a read-only covering
mount for the assertion and rejects symlinked assertion paths. Grant the container
user read/traverse access to this administrator-controlled directory. Do not
mount block devices, `/dev/disk`, or the Docker socket into the container; no
`--privileged`, `--device`, or additional device capabilities are needed.

Immediately before every start/recreation, stop the existing container, invalidate
any old assertion, run preflight, and start only on success. Example host wrapper
body, with UUID/ID exported from the protected host configuration:

```sh
set -eu
docker compose stop gallery
rm -f /run/mygallery-identity/identity.json
python3 scripts/storage-preflight.py \
  /srv/gallery-disk /srv/gallery-disk/library \
  "$MEDIA_STORAGE_UUID" "$MEDIA_STORAGE_ID" \
  /run/mygallery-identity/identity.json
docker compose up -d --force-recreate gallery
```

Provision `/run/mygallery-identity` via an administrator-managed boot unit or
tmpfiles rule before this wrapper runs. Protect the wrapper and configuration.
The script also unlinks its previous output before device probing; failure must
leave the service stopped. Remove the assertion when stopping the service,
before unmounting or replacing storage, and after failed startup. Disable direct
Docker auto-restarts that bypass preflight; have the host supervisor invoke the
wrapper, with mount ordering and lifecycle dependencies as described above.

Assertions contain an issue timestamp and host boot ID. The app rejects malformed,
missing, unreadable, mismatched, future-dated, previous-boot, or **24-hour-old**
assertions on every check. Stop, reverify and recreate the container before that
expiry (scheduled host maintenance is required for continuous service). Atomic
assertion renewal during an active operation deliberately invalidates that
operation's snapshot. Host and container must share the host boot ID and wall
clock; time namespaces/virtualized `/proc` require separate review.

These checks establish only that a trusted host verified identity at the recorded
time, within a bounded wall-clock age and the same boot. A static assertion does
**not** independently re-probe the UUID during service operation. Device numbers
can be reused after removal, timestamps depend on a trustworthy clock, and a
copied marker plus reused device number could satisfy a still-valid assertion
for a newly started operation. In-progress operations also pin device, root inode,
mount ID and assertion content, but this cannot eliminate all check/syscall races.
The assertion is not signed; host ownership and the read-only container mount
are the trust boundary. This is weaker than native mode's repeated direct UUID
verification. Keep the host mount stable while running, retain unwritable fallback
directories and unprivileged application credentials, and stop on USB loss.
