import pg from "pg"

const { Pool } = pg

/**
 * Direct Postgres connection (raw SQL paths: row locks, transactions,
 * Document Management, cargo capacity).
 *
 * DATABASE_URL must use Supabase's pooler in TRANSACTION mode (port 6543).
 * Session mode (5432) reserves a slot per open connection, idle or not, and the
 * plan allows only 15 across every server, script and test, which ran out
 * (EMAXCONNSESSION, 2026-11-12). Transaction mode holds a slot only while a
 * query or BEGIN … COMMIT runs. Nothing here may rely on session state: no
 * named prepared statements, session SET, LISTEN or session advisory locks.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
})
