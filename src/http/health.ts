/** Verificações de saúde usadas por `/health/ready` (monitor externo e deploy). */
export type HealthCheck = () => Promise<boolean>;

export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';
/** O worker grava a cada 30 s; mais de 2 min sem gravar = worker parado. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = 120_000;

export async function runChecks(checks: Record<string, HealthCheck>): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        const ok = await Promise.race([check(), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
        return [name, ok] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
