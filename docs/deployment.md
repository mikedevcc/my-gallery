# My Gallery - Server Prerequisites

## Operating System
- Debian

## Runtime
- Node.js
- npm

## Database
- PostgreSQL
- PostGIS

## Media Tools
- ExifTool

## Reverse Geocoding
- Nominatim
- PostgreSQL 17.7
- PostGIS 3.6.0 available to PostgreSQL 17
- osm2pgsql 1.8+
- Python 3.9+
- virtualenv
- pkg-config
- libicu-dev
- git
- build-essential

## Nominatim installation status

- Nominatim: 5.3.2
- nominatim-db: 5.3.2
- nominatim-api: 5.3.2
- Python virtual environment:
  `/srv/nominatim/nominatim-venv`
- Nominatim project directory:
  `/srv/nominatim/project`

### Failed initial import cleanup

If a Nominatim import fails after database creation, a partial
`nominatim` database may remain.

Remove it before retrying:

```bash
sudo -u postgres dropdb nominatim

## Nominatim OSM import

Dataset:
- Geofabrik Malaysia / Singapore / Brunei extract
- `malaysia-singapore-brunei-latest.osm.pbf`

Import result:
- Nominatim 5.3.2
- Import completed successfully
- Import time on development machine: ~3678 seconds (~61 minutes)

Command:

```bash
nominatim import \
  --project-dir /srv/nominatim/project \
  --osm-file /srv/nominatim/project/malaysia-singapore-brunei-latest.osm.pbf

## Storage
- Gallery storage root
- Sufficient disk space for media
- Sufficient disk space for OSM/Nominatim data

## Application
- Environment variables
- DATABASE_URL
- Storage root path
- Nominatim service URL

## Nominatim development API

Development server:

```bash
nominatim serve \
  --project-dir /srv/nominatim/project