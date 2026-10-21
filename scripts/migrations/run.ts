import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { canonicalSchema, checksum, discover, pending, pgDumpEnvironment, validateSql, type AppliedMigration, type Migration } from "./core";

const directory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const commands = ["status", "plan", "verify-baseline", "init", "up", "adopt-baseline"];
const usage = `Usage: npm run db:migrate -- <${commands.join("|")}> --host HOST --port PORT --database NAME
Writes require --confirm NAME. Adoption also requires --verified-report PATH.
Set GALLERY_MIGRATION_URL explicitly; DATABASE_URL and .env are never loaded.
verify-baseline emits JSON for independent review; no database writes.`;

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--help" || !command) { console.log(usage); return; }
    if (!commands.includes(command)) throw new Error(usage);
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        const value = args[i + 1];
        if (!["--host", "--port", "--database", "--confirm", "--verified-report"].includes(name) || !value || value.startsWith("--") || flags.has(name)) throw new Error("Invalid or duplicate CLI option");
        flags.set(name, value);
    }
    const connectionString = process.env.GALLERY_MIGRATION_URL;
    if (!connectionString) throw new Error("Set GALLERY_MIGRATION_URL explicitly");
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.port || !url.username || url.hash) throw new Error("Use an explicit PostgreSQL URL with host, port, user and database");
    for (const key of url.searchParams.keys()) if (key !== "sslmode") throw new Error(`Unsupported connection URL option: ${key}`);
    const target = { host: url.hostname, port: url.port, database: decodeURIComponent(url.pathname.slice(1)) };
    if (!/^[a-z][a-z0-9_]*$/.test(target.database) || ["postgres", "template0", "template1"].includes(target.database)) throw new Error("Use a simple lowercase application database name; maintenance databases are forbidden");
    for (const key of ["host", "port", "database"] as const) {
        if (flags.get(`--${key}`) !== target[key]) throw new Error(`Explicit --${key} must match the connection URL`);
    }
    const writes = ["init", "up", "adopt-baseline"].includes(command);
    if (writes && flags.get("--confirm") !== target.database) throw new Error("Writes require --confirm with the exact database name");
    if (command === "adopt-baseline" && !flags.has("--verified-report")) throw new Error("Adoption requires an independently reviewed verification report");
    if (command !== "adopt-baseline" && flags.has("--verified-report")) throw new Error("--verified-report is only valid for adoption");
    const migrations = await discover(directory);
    const client = new Client({ connectionString, options: "", connectionTimeoutMillis: 5000, application_name: "my-gallery-migrations" });
    let connected = false;
    let transaction = false;
    try {
        await client.connect();
        connected = true;
        const identity = await client.query<{ database: string; port: number | null; version: number }>("SELECT current_database() AS database, inet_server_port() AS port, current_setting('server_version_num')::int AS version");
        const actual = identity.rows[0];
        if (actual.database !== target.database || actual.port !== Number(target.port) || Math.floor(actual.version / 10000) !== 17) throw new Error("Connected database, port or PostgreSQL major version does not match the expected target");
        await client.query(writes ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transaction = true;
        await client.query("SET LOCAL search_path = pg_catalog, public");
        await client.query("SET LOCAL standard_conforming_strings = on");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '60s'");
        if (writes) {
            const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(1768382834, 1) AS locked");
            if (!lock.rows[0].locked) throw new Error("Another migration runner holds the database migration lock");
        }
        const exists = (await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0].present as boolean;
        if (exists) await validateLedger();
        const applied = exists ? (await client.query<AppliedMigration>("SELECT version, filename, checksum, applied_at FROM public.schema_migrations ORDER BY version")).rows : [];
        const todo = pending(migrations, applied);
        const empty = (await client.query(`SELECT NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
            UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
            UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','d','r','m')
        ) AS empty`)).rows[0].empty as boolean;

        async function validateLedger() {
            const columns = await client.query("SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute WHERE attrelid='public.schema_migrations'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum");
            const expected = [["version", "integer"], ["filename", "text"], ["checksum", "text"], ["applied_at", "timestamp with time zone"]];
            if (columns.rows.length !== 4 || columns.rows.some((row, i) => row.attname !== expected[i][0] || row.type !== expected[i][1] || !row.attnotnull)) throw new Error("Unexpected schema_migrations column layout");
            const unsafe = await client.query("SELECT c.relkind <> 'r' OR c.relrowsecurity OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS unsafe FROM pg_class c WHERE c.oid='public.schema_migrations'::regclass");
            if (unsafe.rows[0].unsafe) throw new Error("Unexpected migration ledger kind, RLS, triggers or rules");
            const keys = await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.schema_migrations'::regclass");
            if (!["PRIMARY KEY (version)", "UNIQUE (filename)"].every(key => keys.rows.some(row => row.definition === key))) throw new Error("Migration ledger keys are missing");
        }
        async function createLedger() {
            await client.query(`CREATE TABLE public.schema_migrations (
                version integer PRIMARY KEY,
                filename text NOT NULL UNIQUE,
                checksum text NOT NULL,
                applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
        }
        async function record(migration: Migration) {
            await client.query("INSERT INTO public.schema_migrations(version, filename, checksum) VALUES ($1,$2,$3)", [migration.version, migration.filename, migration.checksum]);
        }
        async function verification() {
            const outsidePublic = await client.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) AS present");
            if (outsidePublic.rows[0].present) throw new Error("Unexpected user schemas outside public; independent review required");
            // Password is passed only via the child environment, never argv/logging.
            const env = pgDumpEnvironment(process.env, url);
            const { stdout } = await promisify(execFile)("pg_dump", ["--host", target.host, "--port", target.port, "--username", decodeURIComponent(url.username), "--dbname", target.database, "--no-password", "--schema-only", "--schema=public", "--no-owner", "--no-privileges"], { env, timeout: 60000, maxBuffer: 10 * 1024 * 1024 }).catch(() => { throw new Error("Read-only pg_dump failed; verify client availability/version, credentials and privileges"); });
            const canonical = canonicalSchema(stdout);
            if (canonical !== canonicalSchema(migrations[0].sql)) throw new Error("Public schema differs from baseline; adoption refused");
            return { ...target, baselineChecksum: migrations[0].checksum, schemaChecksum: checksum(canonical) };
        }

        if (command === "status" || command === "plan") {
            const sqlPolicyErrors = todo.flatMap(item => {
                try { validateSql(item.sql); return []; }
                catch (error) { return [{ filename: item.filename, error: error instanceof Error ? error.message : "Unsupported SQL" }]; }
            });
            console.log(JSON.stringify({ target, state: applied.length ? "tracked" : empty ? "fresh" : "untracked-schema: explicit adoption required", applied, pending: todo.map(({ version, filename, checksum }) => ({ version, filename, checksum })), executable: sqlPolicyErrors.length === 0 && (applied.length > 0 || empty), sqlPolicyErrors }, null, 2));
        } else if (command === "verify-baseline") {
            if (exists) throw new Error("Baseline verification requires an untracked database; inspect existing ledger instead");
            console.log(JSON.stringify({ ...await verification(), verifiedAt: new Date().toISOString(), reviewedBy: "", reviewDecision: "pending" }, null, 2));
        } else if (command === "adopt-baseline") {
            if (exists) throw new Error("Ledger already exists; adoption refused");
            const report = JSON.parse(await readFile(path.resolve(flags.get("--verified-report")!), "utf8")) as Record<string, unknown>;
            const verified = await verification();
            if (Object.entries(verified).some(([key, value]) => report[key] !== value) || typeof report.reviewedBy !== "string" || !report.reviewedBy.trim() || report.reviewDecision !== "approved" || typeof report.verifiedAt !== "string" || !Number.isFinite(Date.parse(report.verifiedAt))) throw new Error("Report must match this target/schema/baseline and include independent reviewer approval");
            await createLedger();
            await record(migrations[0]);
            console.log("Prepared baseline 0001 record; application DDL was not executed. Retain the reviewed report in deployment records.");
        } else {
            if (command === "init" && (exists || !empty)) throw new Error("init requires a completely empty user schema and no ledger; existing databases require adoption");
            if (command === "up" && (!exists || !applied.length)) throw new Error("up requires initialized or explicitly adopted history; use init or adopt-baseline first");
            for (const item of todo) validateSql(item.sql);
            if (command === "init") await createLedger();
            for (const item of todo) {
                console.log(`Applying ${item.filename}`);
                try { await client.query(item.sql); await record(item); }
                catch (cause) { throw new Error(`Migration ${item.filename} failed`, { cause }); }
            }
        }
        await client.query("COMMIT");
        transaction = false;
        if (writes) console.log("Committed successfully.");
    } catch (error) {
        if (transaction) {
            try { await client.query("ROLLBACK"); }
            catch { console.error("Rollback acknowledgement failed; verify database state before retrying."); }
        }
        throw error;
    } finally {
        if (connected) await client.end();
    }
}

main().catch(error => {
    // Do not print connection strings, child-process argv, SQL values or stacks.
    const message = error instanceof Error ? error.message : "Unknown error";
    const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
    console.error(`Migration command failed: ${message}${cause?.code ? ` (PostgreSQL ${cause.code})` : ""}`);
    process.exitCode = 1;
});
