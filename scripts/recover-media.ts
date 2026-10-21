import { Client } from "pg";
import { getMediaStorageRoot } from "./storage-safety";
import { recoverReplacement } from "./replacement-files";

// Explicit maintenance command. Never runs from Next.js startup or request paths.
async function main() {
    const [operationId, ...args] = process.argv.slice(2);
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        if (!["--host", "--port", "--database", "--confirm-installation"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error("Invalid recovery options");
        flags.set(args[i], args[i + 1]);
    }
    if (!operationId || !/^[0-9a-f-]{36}$/i.test(operationId) || !process.env.MEDIA_RECOVERY_DATABASE_URL) throw new Error("Usage: recover-media.ts OPERATION_UUID --host HOST --port PORT --database NAME --confirm-installation STORAGE_ID; set MEDIA_RECOVERY_DATABASE_URL and storage configuration explicitly");
    if (!process.env.MEDIA_STORAGE_ID || flags.get("--confirm-installation") !== process.env.MEDIA_STORAGE_ID) throw new Error("Explicit installation confirmation required");
    const url = new URL(process.env.MEDIA_RECOVERY_DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.hostname || !url.port || url.hash || [...url.searchParams.keys()].some(key => key !== "sslmode")) throw new Error("Explicit PostgreSQL target required");
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[a-z][a-z0-9_]*$/.test(database) || ["postgres", "template0", "template1"].includes(database)
        || flags.get("--host") !== url.hostname || flags.get("--port") !== url.port || flags.get("--database") !== database) throw new Error("Unexpected recovery database target");
    const probe = new Client({ connectionString: url.href, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 5000 });
    try {
        await probe.connect();
        const row = (await probe.query("SELECT current_database() AS name, inet_server_port() AS port, current_user AS role, current_setting('server_version_num')::int AS version")).rows[0];
        if (row.name !== database || row.port !== Number(url.port) || row.role !== decodeURIComponent(url.username) || Math.floor(row.version / 10000) !== 17) throw new Error("Recovery connection identity mismatch");
    } finally { await probe.end(); }
    process.env.DATABASE_URL = url.href; // Set before loading the application's pool; never load .env.
    const { withReplacementRecoveryDatabase, closeMediaDatabase } = await import("./media-database");
    try { console.log(await recoverReplacement(getMediaStorageRoot(), operationId, withReplacementRecoveryDatabase)); }
    finally { await closeMediaDatabase(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; });
