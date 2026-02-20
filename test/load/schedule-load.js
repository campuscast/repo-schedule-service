// k6 load test placeholder
// Run: k6 run test/load/schedule-load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // convergence <200ms target
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const BASE_URL = __ENV.BASE_URL || 'http://localhost:3005';

  // Create schedule op
  const payload = JSON.stringify({
    ops: [{
      op_type: 'add_slot',
      causal: { operation_id: `op-${Date.now()}-${Math.random()}`, client_id: `k6-vu-${__VU}`, lamport_ts: Date.now() },
      slot: { slot_id: `slot-${Date.now()}`, start_time: new Date().toISOString(), end_time: new Date(Date.now() + 3600000).toISOString(), priority: 1 },
    }],
    crdt_enabled: true,
  });

  const res = http.post(`${BASE_URL}/schedules/test-schedule/ops`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, { 'status is 200/201': (r) => r.status === 200 || r.status === 201 });
  sleep(0.1);
}
