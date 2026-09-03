# CampusCast Schedule Service

Schedule Service is a NestJS service in the CampusCast digital-signage prototype. It stores schedules and slots, supports locking or CRDT-based editing, creates immutable schedule versions, and coordinates validation, signing, and release publication with other CampusCast services.

This repository is a research-oriented prototype. It is not a standalone production deployment.

## Stack

- Node.js 22 and TypeScript
- NestJS 10
- TypeORM with PostgreSQL
- Redis for the locking strategy
- Jest, ts-jest, and fast-check
- Docker (multi-stage Alpine image)

## Repository dependency

`@campuscast/shared-libs` is currently a local file dependency. Keep these two repositories as siblings:

```text
campuscast-workspace/
├── repo-schedule-service/
└── repo-shared-libs/
```

CI checks out `repo-shared-libs` at commit `33b17d3f409c53a9be676bd4448ae015fe700c30`. Using the same commit locally gives the closest match to CI:

```bash
mkdir campuscast-workspace
cd campuscast-workspace
git clone https://github.com/campuscast/repo-shared-libs.git
git -C repo-shared-libs checkout 33b17d3f409c53a9be676bd4448ae015fe700c30
git clone https://github.com/campuscast/repo-schedule-service.git

cd repo-shared-libs
npm ci
npm run build

cd ../repo-schedule-service
npm ci
```

Running `npm ci` from a standalone clone creates an unresolved local link, so the sibling checkout and shared-library build are required before building or starting this service.

## Local development

Prerequisites:

- Node.js 22
- npm (the version bundled with Node.js 22 is supported)
- PostgreSQL 16 or a compatible server
- Redis 7 or a compatible server
- Docker, only for the container workflow

Start disposable development dependencies:

```bash
docker run --rm -d --name campuscast-schedule-postgres \
  -e POSTGRES_USER=campuscast \
  -e POSTGRES_PASSWORD=campuscast \
  -e POSTGRES_DB=schedule_db \
  -p 5432:5432 postgres:16-alpine

docker run --rm -d --name campuscast-schedule-redis \
  -p 6379:6379 redis:7-alpine
```

Then, from `repo-schedule-service`:

```bash
cp .env.example .env
npm run start:dev
curl --fail http://localhost:3005/health
```

Database migrations run at startup unless `DB_MIGRATIONS_RUN=false`. Set real secret values outside `.env.example`; never commit them.

## Verification

After building the sibling shared library, run:

```bash
npm ci
npm run lint
npm run build
npm run test:unit
npm run test:property
```

`npm test` runs the complete Jest suite. The dedicated unit and property commands are separate in CI so each category is visible.

Build the image from the directory that contains both repositories:

```bash
docker build \
  --file repo-schedule-service/Dockerfile \
  --tag campuscast/schedule-service:local \
  .
```

The image listens on port `3005`. A running container also needs reachable PostgreSQL and Redis instances.

## Configuration

`.env.example` contains local, non-production defaults. The main variables are:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | Runtime mode, HTTP port, and logging level |
| `DATABASE_URL` | PostgreSQL connection string |
| `DB_MIGRATIONS_RUN`, `DB_SYNCHRONIZE` | TypeORM migration and schema synchronization controls |
| `REDIS_URL` | Redis connection used by locking |
| `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` | Secret material; intentionally blank in the example file |
| `CORS_ORIGIN` | Comma-separated allowed browser origins |
| `CRDT_GLOBAL_ENABLED`, `CRDT_COMPACTION_THRESHOLD` | Editing strategy and compaction controls |
| `ZONE_SERVICE_URL`, `CONTENT_SERVICE_URL`, `DEVICE_SERVICE_URL` | Domain service endpoints |
| `VALIDATION_QA_URL`, `SIGNING_KMS_URL`, `SYNC_SERVICE_URL` | Publication pipeline endpoints |
| `AUDIT_SERVICE_URL` | Audit sink endpoint |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `METRICS_PORT` | Observability endpoints |

## Implemented surface

- Schedule create, list, read, delete, and calendar/day views
- Lock acquisition, refresh, release, and locked draft saves
- CRDT operation ingestion and snapshot reads
- Schedule version creation and validation
- Release publication, listing, manifest access, and device-specific latest release lookup
- Health, readiness, liveness, and metrics endpoints
- Unit tests plus property-based convergence and merge-policy tests

## Known limitations

- Local builds require the sibling `repo-shared-libs`; the dependency is not published as a package.
- Publication calls several other CampusCast services and cannot be exercised end-to-end with only this repository.
- Load testing is planned. The previous placeholder workflow and unverified k6 scenario were removed instead of presenting them as an executed load test.
- Several external payloads still use broad TypeScript types. ESLint reports these as warnings so the debt remains visible while existing behavior is preserved.
- The production dependency tree still has transitive npm audit findings. Dependency upgrades need a separate compatibility pass across this service and `repo-shared-libs`.
- The repository does not provision or back up PostgreSQL and Redis; orchestration belongs to `repo-infra`.
