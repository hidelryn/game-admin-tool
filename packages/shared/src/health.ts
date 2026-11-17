export type DependencyStatus = 'up' | 'down';

export interface HealthReadyResponse {
  status: 'ok' | 'degraded';
  checks: {
    mysql: DependencyStatus;
    redis: DependencyStatus;
  };
}
