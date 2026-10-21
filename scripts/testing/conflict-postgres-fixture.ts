// Test-only PostgreSQL guards. No .env loading, migrations or query-result mocks.
import { Client, Pool, type PoolClient } from "pg";

const identitySql = `SELECT current_database() AS database, current_user AS role,
    inet_server_port() AS port, current_setting('data_directory') AS directory,
    current_setting('server_version_num')::int AS version`;
export function conflictPostgresTarget() {
    const url = new URL(process.env.N1_INTEGRATION_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55439" || !url.username
        || !/^\/h4c_replacement_test_n1_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) throw new Error("Non-isolated N1 integration target refused");
    return url;
}
export async function verifyConflictPostgres(client: Pick<Client, "query">) {
    const url = conflictPostgresTarget();
    const row = (await client.query(identitySql)).rows[0];
    if (row.database !== url.pathname.slice(1) || row.role !== decodeURIComponent(url.username) || row.port !== 55439
        || row.directory !== "/tmp/mygallery-runner-integration-du1UxD/data" || Math.floor(row.version / 10000) !== 17) throw new Error("N1 PostgreSQL instance identity mismatch");
}
export async function checkedConflictQuery(client: Client, sql: string, values?: unknown[]) {
    // Every fixture write/transaction is preceded by positive identity verification.
    // ROLLBACK is limited to this already verified connection, including SQL errors.
    if (sql !== "ROLLBACK") await verifyConflictPostgres(client);
    return client.query(sql, values);
}
export function guardConflictPool(beforeQuery?: (sql: string) => Promise<void>) {
    const original = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
    Pool.prototype.connect = (async function(this: Pool) {
        const client = await original.call(this), raw = client.query.bind(client);
        const probe = { query: raw } as Pick<Client, "query">;
        try { await verifyConflictPostgres(probe); }
        catch (error) { client.release(); throw error; }
        return { query: async (sql: string, values?: unknown[]) => {
            if (sql !== "ROLLBACK") await verifyConflictPostgres(probe);
            await beforeQuery?.(sql);
            return raw(sql, values); // Real SQL, real rows and real advisory locks.
        }, release: client.release.bind(client) } as unknown as PoolClient;
    }) as typeof Pool.prototype.connect;
    return () => { Pool.prototype.connect = original as typeof Pool.prototype.connect; };
}
