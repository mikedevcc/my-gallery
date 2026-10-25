#!/usr/bin/env python3
"""Conservative repo scan. Prints paths and line numbers, never secret values.
Not a substitute for a full git-history scan with Gitleaks.
"""
import os, re, subprocess, sys
from pathlib import Path

BAD_NAMES = re.compile(r'(^|/)(?:\.env(?:\.|$)|id_(?:ed25519|rsa)(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|.*\.(?:dump|backup)$)', re.I)
PATTERNS = [
    re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----'),
    re.compile(rb'github_pat_[A-Za-z0-9_]{15,}'),
    re.compile(rb'gh[pousr]_[A-Za-z0-9]{20,}'),
    re.compile(rb'(?i)(?:postgresql|postgres)://[^\s\"\']+:[^\s\"\'@]+@'),
    re.compile(rb'(?i)(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*[\"\']?[^\s\"\']{10,}'),
]
result = subprocess.run(['git','ls-files','-z'],check=True,stdout=subprocess.PIPE)
flags=[]
for raw in result.stdout.split(b'\0'):
    if not raw: continue
    name=os.fsdecode(raw)
    if name != '.env.example' and BAD_NAMES.search(name): flags.append(f'Filename review: {name}')
    path=Path(name)
    if not path.is_file() or path.stat().st_size > 5_000_000: continue
    try: data=path.read_bytes()
    except OSError: continue
    if b'\x00' in data[:4096]: continue
    for lineno,line in enumerate(data.splitlines(),1):
        if name == '.env.example':
            # Review placeholders separately; don't flag example credentials.
            continue
        if any(pattern.search(line) for pattern in PATTERNS):
            flags.append(f'Possible credential: {name}:{lineno}')
print('Tracked files inspected; no secret values printed.')
for flag in flags: print(flag)
print('This scans the current checkout, NOT Git history; use Gitleaks before publishing.')
sys.exit(1 if flags else 0)
