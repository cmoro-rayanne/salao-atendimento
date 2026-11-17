import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

/** Uma transação (`sql.begin`) usa a mesma interface de consulta; o tipo da biblioteca é só mais estreito. */
export const asSql = (tx: unknown): Sql => tx as Sql;
