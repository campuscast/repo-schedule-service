# repo-schedule-service

Schedule Service — CRUD, versioning, locking/CRDT strategy, publish

## Local

- Install:       npm ci
- Build:       npm run build
- Test:       npm test -- --passWithNoTests

## Runtime

- Health:         GET /health
- Metrics:         GET /metrics
- For player release lookup, schedule-service calls device-management with `X-Internal-Token` from `INTERNAL_SERVICE_TOKEN`.
- Audit sink: set `AUDIT_SERVICE_URL` (for Docker: `http://audit-service:3009`).
- Audit events on publish flow: `schedule.publish_requested`, `schedule.manifest_signed`, `schedule.rollout_sent`, `schedule.published`.
