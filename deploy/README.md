# Example deployment assets

`compose.yaml.example` illustrates the topology tested on the Debian 13 NAS.
It is a template **not a working installation**: paths, roles, image tag and
protected environment files must be reviewed for each installation.

Do not commit `/etc/mygallery/*.env`, the production assertion file, backups,
media, live database volumes or other credentials. Host systemd scripts and
units are intentionally **not included yet**; copy and generalize them from the
working NAS after independent review, removing the hardcoded filesystem UUID
and installation ID and preserving the lifecycle lock and fail-closed behavior.

See [Docker deployment guide](../docs/docker-deployment.md).
