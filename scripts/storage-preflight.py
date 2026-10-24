#!/usr/bin/env python3
"""Host only. No media writes. Requires Python 3 and util-linux blkid."""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def require(condition):
    if not condition:
        raise ValueError("Storage identity check failed")


def main():
    # Arguments: actual host mountpoint, media root, UUID, installation ID,
    # assertion output (in an existing protected directory outside the USB).
    mountpoint, root, uuid, installation, output = sys.argv[1:]
    output = Path(output)
    mountpoint, root = Path(mountpoint), Path(root)
    require(mountpoint.is_absolute() and root.is_absolute())
    require(not output.is_relative_to(mountpoint) and not output.is_relative_to(root))
    require(output.is_absolute() and output.parent.resolve() == output.parent)
    # Invalidate the previous assertion before probing, including on failure.
    output.unlink(missing_ok=True)
    for value in (uuid, installation):
        require(re.fullmatch(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", value))
    mountpoint, root = Path(mountpoint), Path(root)
    require(mountpoint.is_absolute() and root.is_absolute())
    require(mountpoint.resolve() == mountpoint and root.resolve() == root)
    require(root.is_relative_to(mountpoint) and not output.is_relative_to(mountpoint))
    require(mountpoint != Path("/") and root.is_dir())

    def mount_entry():
        entries = []
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            left, right = line.split(' - ')
            fields, fsfields = left.split(), right.split()
            target = Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4]))
            if root.is_relative_to(target):
                entries.append((len(str(target)), fields, fsfields, target))
        _, fields, fsfields, target = max(entries, key=lambda entry: entry[0])
        require(target == mountpoint and fsfields[0] in ('ext4', 'xfs'))
        require('ro' not in fields[5].split(',') and 'ro' not in fsfields[2].split(','))
        return fields, fsfields

    before = mount_entry()
    device_path = '/dev/disk/by-uuid/' + uuid
    device = os.stat(device_path)
    require(stat.S_ISBLK(device.st_mode))
    # Probe the actual block device, bypassing blkid's cache.
    actual_uuid = subprocess.check_output(['blkid', '-p', '-s', 'UUID', '-o', 'value', device_path], text=True).strip()
    require(actual_uuid == uuid)
    root_stat = root.stat()
    require(root_stat.st_dev == device.st_rdev)
    require(before[0][2] == f'{os.major(device.st_rdev)}:{os.minor(device.st_rdev)}')
    marker_path = root / '.mygallery-storage.json'
    fd = os.open(marker_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as marker_file:
        marker_stat = os.fstat(marker_file.fileno())
        require(stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_dev == root_stat.st_dev and marker_stat.st_size <= 4096)
        marker = json.load(marker_file)
    require(marker == dict(version=1, installationId=installation, filesystemUuid=uuid))
    require(mount_entry() == before)
    after = root.stat()
    require((after.st_dev, after.st_ino) == (root_stat.st_dev, root_stat.st_ino))
    assertion = dict(version=1, filesystemUuid=uuid, installationId=installation,
                     device=str(root_stat.st_dev), issuedAt=time.time_ns() // 1_000_000,
                     bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.storage-assertion-', dir=output.parent)
        with os.fdopen(fd, 'w') as stream:
            json.dump(assertion, stream)
            stream.flush()
            os.fchmod(stream.fileno(), 0o444)
            os.fsync(stream.fileno())
        os.replace(temporary, output)
        directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('Storage preflight failed; container must remain stopped')
