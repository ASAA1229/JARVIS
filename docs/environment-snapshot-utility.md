# Environment Snapshot Utility (Linux / AIX)

## Purpose
A standalone, customer-runnable Python 3 utility that captures a small, read-only
snapshot of supported server operating-system configuration. It is separate from
the audit script and the on-site file-change detector.

## Supported platforms
- Linux: reads `/etc/os-release`; runs `uname -srm`, `hostname`,
  `uptime -p`, and `date +%z`.
- IBM AIX: runs `oslevel -s`, `uname -a`, `hostname`, `uptime`,
  and `date +%z`.
- Any other OS: exits with an unsupported-platform error before running commands.

## Run
Requires Python 3.9+ and no third-party packages.

```sh
python3 scripts/environment_snapshot.py
python3 scripts/environment_snapshot.py --output /path/to/customer-snapshot.json
python3 scripts/environment_snapshot.py --stdout
```

The default output is `environment-snapshot.json` in the current directory.
The output is JSON with schema version 1. A temporary file is written and then
renamed into place so an incomplete output is not presented as a completed snapshot.

## Safety and scope
- Read-only collection; no configuration changes, package installs, service restarts,
  privilege escalation, network calls, or writes outside the requested output path.
- Does not collect hardware inventory, CPU/RAM details, storage, disks, filesystems,
  mount points, environment variables, credentials, process lists, or user accounts.
- Run with a normal, non-root account unless the customer environment requires otherwise.
- Review the JSON before sharing it; hostname and OS details may be operationally sensitive.
- If a required command fails or returns empty output, collection fails and no final
  snapshot is written. Resolve the reported issue and rerun.

## Exit codes
- `0`: snapshot successfully written or printed.
- `1`: unsupported OS, collection failure, or output failure.
- `2`: command-line usage error (provided by argparse).

## Tests
Run from repository root:

```sh
python3 -m unittest discover -s tests -p 'test_environment_snapshot.py' -v
```

AIX command execution must still be validated on an actual supported AIX host before
customer production rollout; Linux unit tests cannot prove AIX command availability
or output formatting on every AIX release.
