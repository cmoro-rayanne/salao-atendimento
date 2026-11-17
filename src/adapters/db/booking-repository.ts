import type {
  BookedClass,
  BookingRepository,
  BookingRequest,
  BookResult,
  ReminderInfo,
  TrialSlot,
} from '../../modules/trial-classes/ports.js';
import type { Sql } from './client.js';

interface BookedRow {
  booking_id: string;
  slot_id: string;
  modality: string;
  starts_at: Date;
}

const toBooked = (r: BookedRow): BookedClass => ({
  bookingId: Number(r.booking_id),
  slotId: Number(r.slot_id),
  modality: r.modality,
  startsAt: r.starts_at,
});

export class PgBookingRepository implements BookingRepository {
  constructor(private readonly sql: Sql) {}

  async listAvailable(tenantId: number, from: Date, to: Date, modality?: string): Promise<TrialSlot[]> {
    const rows = await this.sql<{ id: string; modality: string; starts_at: Date; capacity: number; booked: number }[]>`
      select id, modality, starts_at, capacity, booked from trial_slots
      where tenant_id = ${tenantId}
        and starts_at >= ${from} and starts_at < ${to}
        and booked < capacity
        ${modality ? this.sql`and modality ilike ${'%' + modality + '%'}` : this.sql``}
      order by starts_at, modality
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      modality: r.modality,
      startsAt: r.starts_at,
      capacity: r.capacity,
      booked: r.booked,
    }));
  }

  async book(req: BookingRequest): Promise<BookResult> {
    return this.sql.begin(async (tx): Promise<BookResult> => {
      // O upsert trava a linha do lead até o fim da transação: pedidos simultâneos do
      // mesmo contato ficam em fila e o segundo enxerga a reserva do primeiro.
      const [lead] = await tx<{ id: string }[]>`
        insert into leads (tenant_id, phone, chatwoot_contact_id, name)
        values (${req.tenantId}, ${req.contact.phone}, ${req.contact.chatwootContactId}, ${req.contact.name})
        on conflict (tenant_id, phone) do update set
          chatwoot_contact_id = excluded.chatwoot_contact_id,
          name = coalesce(leads.name, excluded.name),
          updated_at = now()
        returning id
      `;
      const leadId = lead!.id;

      const [existing] = await tx<BookedRow[]>`
        select b.id as booking_id, s.id as slot_id, s.modality, s.starts_at
        from trial_bookings b join trial_slots s on s.id = b.slot_id
        where b.lead_id = ${leadId} and b.status = 'agendada' and s.starts_at > now()
        order by s.starts_at limit 1
      `;
      if (existing) {
        return Number(existing.slot_id) === req.slotId
          ? { kind: 'already_booked', booking: toBooked(existing) }
          : { kind: 'has_other', booking: toBooked(existing) };
      }

      // Ocupa a vaga de forma atômica: só incrementa se ainda houver vaga.
      const [slot] = await tx<{ id: string; modality: string; starts_at: Date }[]>`
        update trial_slots set booked = booked + 1
        where id = ${req.slotId} and tenant_id = ${req.tenantId}
          and starts_at >= ${req.notBefore} and booked < capacity
        returning id, modality, starts_at
      `;
      if (!slot) {
        const [s] = await tx<{ booked: number; capacity: number; starts_at: Date }[]>`
          select booked, capacity, starts_at from trial_slots where id = ${req.slotId} and tenant_id = ${req.tenantId}
        `;
        return s && s.starts_at >= req.notBefore && s.booked >= s.capacity ? { kind: 'full' } : { kind: 'not_available' };
      }

      const [booking] = await tx<{ id: string }[]>`
        insert into trial_bookings (slot_id, lead_id, status, chatwoot_account_id, chatwoot_conversation_id)
        values (${slot.id}, ${leadId}, 'agendada', ${req.conversation.accountId}, ${req.conversation.conversationId})
        on conflict (slot_id, lead_id) do update set
          status = 'agendada',
          cancelled_at = null,
          reminder_sent_at = null,
          reminder_job_id = null,
          chatwoot_account_id = excluded.chatwoot_account_id,
          chatwoot_conversation_id = excluded.chatwoot_conversation_id
        returning id
      `;

      await tx`
        update leads set status = 'experimental_agendada', version = version + 1, updated_at = now()
        where id = ${leadId} and status in ('novo', 'qualificado')
      `;

      return {
        kind: 'booked',
        booking: { bookingId: Number(booking!.id), slotId: Number(slot.id), modality: slot.modality, startsAt: slot.starts_at },
      };
    });
  }

  async setReminderJob(bookingId: number, jobId: string | null): Promise<void> {
    await this.sql`update trial_bookings set reminder_job_id = ${jobId} where id = ${bookingId}`;
  }

  async cancelActive(
    tenantId: number,
    phone: string,
    now: Date,
  ): Promise<{ kind: 'cancelled'; booking: BookedClass; reminderJobId: string | null } | { kind: 'none' }> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<(BookedRow & { reminder_job_id: string | null })[]>`
        select b.id as booking_id, s.id as slot_id, s.modality, s.starts_at, b.reminder_job_id
        from trial_bookings b
        join trial_slots s on s.id = b.slot_id
        join leads l on l.id = b.lead_id
        where l.tenant_id = ${tenantId} and l.phone = ${phone}
          and b.status = 'agendada' and s.starts_at > ${now}
        order by s.starts_at limit 1
        for update of b
      `;
      if (!row) return { kind: 'none' as const };

      await tx`update trial_bookings set status = 'cancelada', cancelled_at = now() where id = ${row.booking_id}`;
      await tx`update trial_slots set booked = booked - 1 where id = ${row.slot_id} and booked > 0`;
      return { kind: 'cancelled' as const, booking: toBooked(row), reminderJobId: row.reminder_job_id };
    });
  }

  async getForReminder(bookingId: number): Promise<ReminderInfo | null> {
    const [r] = await this.sql<
      {
        id: string;
        status: string;
        reminder_sent_at: Date | null;
        starts_at: Date;
        modality: string;
        name: string | null;
        opted_out_at: Date | null;
        chatwoot_account_id: string | null;
        chatwoot_conversation_id: string | null;
        time_zone: string;
      }[]
    >`
      select b.id, b.status, b.reminder_sent_at, s.starts_at, s.modality, l.name, l.opted_out_at,
             b.chatwoot_account_id, b.chatwoot_conversation_id, t.time_zone
      from trial_bookings b
      join trial_slots s on s.id = b.slot_id
      join leads l on l.id = b.lead_id
      join tenants t on t.id = s.tenant_id
      where b.id = ${bookingId}
    `;
    if (!r) return null;
    return {
      bookingId: Number(r.id),
      status: r.status,
      reminderSentAt: r.reminder_sent_at,
      startsAt: r.starts_at,
      modality: r.modality,
      leadName: r.name,
      optedOut: r.opted_out_at !== null,
      accountId: r.chatwoot_account_id === null ? null : Number(r.chatwoot_account_id),
      conversationId: r.chatwoot_conversation_id === null ? null : Number(r.chatwoot_conversation_id),
      timeZone: r.time_zone,
    };
  }

  async markReminderSent(bookingId: number): Promise<boolean> {
    const rows = await this.sql`
      update trial_bookings set reminder_sent_at = now()
      where id = ${bookingId} and reminder_sent_at is null
      returning id
    `;
    return rows.length === 1;
  }

  async clearReminderSent(bookingId: number): Promise<void> {
    await this.sql`update trial_bookings set reminder_sent_at = null where id = ${bookingId}`;
  }
}
