import type { ProcessedEventStore } from '../../modules/conversation/ports.js';
import type { Sql } from './client.js';

/** Idempotência via PK: o INSERT só afeta linha se o evento for novo. */
export class PgProcessedEventStore implements ProcessedEventStore {
  constructor(private readonly sql: Sql) {}

  async markIfNew(eventId: string): Promise<boolean> {
    const rows = await this.sql`
      insert into processed_events (event_id) values (${eventId})
      on conflict (event_id) do nothing
      returning event_id
    `;
    return rows.length === 1;
  }
}
