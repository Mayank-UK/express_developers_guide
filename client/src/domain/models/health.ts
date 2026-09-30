/**
 * HealthReport — the pure domain model of GET /api/health, the liveness probe
 * behind the home screen's live status chip.
 */
export interface HealthReport {
  status: 'ok';
  uptimeSeconds: number;
  requestId: string;
}
