// Explicitly opted-in isolated-cluster tests. No .env or automatic provisioning.
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Client, Pool, type PoolClient } from "pg";

type Fixture = { root: string; directory: string; socket: string; url: string; started: string };
export async function collectionsFixture(): Promise<Fixture> {
    const file = process.env.COLLECTION_PG_FIXTURE;
    assert.ok(file && path.isAbsolute(file), "Explicit COLLECTION_PG_FIXTURE required");
    const root = path.dirname(file);
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^gallery-collections-[a-zA-Z0-9_-]+$/);
    assert.equal(await fs.realpath(root), root);
    const stat = await fs.lstat(root);
    assert.equal(stat.uid, process.getuid?.()); assert.equal(stat.mode & 0o777, 0o700);
    const metadata = await fs.lstat(file);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink()); assert.equal(metadata.uid, stat.uid);
    assert.equal(metadata.mode & 0o777, 0o600);
    const fixture = JSON.parse(await fs.readFile(file, "utf8")) as Fixture;
    assert.equal(fixture.root, root); assert.equal(fixture.directory, path.join(root, "data"));
    assert.equal(fixture.socket, path.join(root, "socket"));
    const url = new URL(fixture.url);
    assert.equal(url.protocol, "postgresql:"); assert.equal(decodeURIComponent(url.hostname), fixture.socket);
    assert.equal(url.port, "55439"); assert.equal(url.username, "collection_test"); assert.equal(url.password, "");
    assert.equal(url.pathname, "/gallery_collections_test"); assert.equal(url.search, ""); assert.equal(url.hash, "");
    return fixture;
}
export async function verifyCollections(client: Pick<Client, "query">, fixture: Fixture) {
    const row = (await client.query(`SELECT current_database() AS database, current_user AS role,
        current_setting('data_directory') AS directory, current_setting('server_version_num')::int AS version,
        pg_postmaster_start_time()::text AS started`)).rows[0];
    assert.equal(row.database, "gallery_collections_test"); assert.equal(row.role, "collection_test");
    assert.equal(row.directory, fixture.directory); assert.equal(row.started, fixture.started);
    assert.equal(Math.floor(row.version / 10000), 17);
}
export async function checkedCollectionsQuery(client: Client, fixture: Fixture, sql: string, values?: unknown[]) {
    // PostgreSQL cannot execute the identity SELECT in a failed transaction.
    // ROLLBACK uses only this previously verified, non-rebindable connection.
    if (sql !== "ROLLBACK") await verifyCollections(client, fixture);
    return client.query(sql, values);
}
export function guardCollectionsPool(fixture: Fixture) {
    const original = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
    Pool.prototype.connect = (async function(this: Pool) {
        const client = await original.call(this), raw = client.query.bind(client);
        const probe = { query: raw } as Pick<Client, "query">;
        try { await verifyCollections(probe, fixture); await raw("SET statement_timeout = '5s'"); }
        catch (error) { client.release(); throw error; }
        return { query: async (sql: string, values?: unknown[]) => {
            if (sql !== "ROLLBACK") await verifyCollections(probe, fixture);
            return raw(sql, values);
        }, release: client.release.bind(client) } as unknown as PoolClient;
    }) as typeof Pool.prototype.connect;
    return () => { Pool.prototype.connect = original as typeof Pool.prototype.connect; };
}
