import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Migration = { version: number; filename: string; checksum: string; sql: string };
export type AppliedMigration = { version: number; filename: string; checksum: string; applied_at: Date };
export const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

export function pgDumpEnvironment(parent: NodeJS.ProcessEnv, url: URL): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...parent,
        PGOPTIONS: "-c default_transaction_read_only=on",
        PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
    };
    // libpq interprets an empty PGSERVICE as a service name, not as disabled.
    // Omit service configuration entirely; pg_dump receives explicit target args.
    delete env.PGSERVICE;
    delete env.PGSERVICEFILE;
    delete env.PGPASSWORD;
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    return env;
}

// This deliberately small SQL lexer supports the project's declarative migrations.
// Comments and string contents cannot disguise statement boundaries or commands.
export function statements(sql: string): string[] {
    const result: string[] = [];
    let current = "";
    for (let i = 0; i < sql.length;) {
        if (sql.startsWith("--", i)) {
            const end = sql.indexOf("\n", i);
            i = end < 0 ? sql.length : end;
            current += " ";
        } else if (sql.startsWith("/*", i)) {
            let depth = 1;
            i += 2;
            while (i < sql.length && depth) {
                if (sql.startsWith("/*", i)) { depth++; i += 2; }
                else if (sql.startsWith("*/", i)) { depth--; i += 2; }
                else i++;
            }
            if (depth) throw new Error("Unterminated SQL comment");
            current += " ";
        } else if (sql[i] === "'" || sql[i] === '"') {
            const quote = sql[i];
            const start = i++;
            let closed = false;
            while (i < sql.length) {
                if (sql[i] === quote) {
                    i++;
                    if (sql[i] === quote) { i++; continue; }
                    closed = true;
                    break;
                }
                // Escape strings are outside the supported grammar.
                if (sql[i] === "\\") throw new Error("SQL backslash escapes are unsupported");
                i++;
            }
            if (!closed) throw new Error("Unterminated SQL quoted value");
            current += sql.slice(start, i);
        } else if (sql[i] === ";") {
            if (current.trim()) result.push(current.trim());
            current = "";
            i++;
        } else {
            if (sql[i] === "$" || sql[i] === "\\") throw new Error("Dollar quoting, parameters and psql commands are unsupported");
            current += sql[i++];
        }
    }
    if (current.trim()) throw new Error("Every SQL statement must end with a semicolon");
    return result;
}

export function validateSql(sql: string): void {
    const items = statements(sql);
    if (!items.length) throw new Error("Empty migration");
    const identifier = '(?:[a-z_][a-z0-9_]*|"(?:[^"]|"")+")';
    const table = `public\\s*\\.\\s*${identifier}`;
    const allowed = new RegExp(`^(?:CREATE TABLE ${table}\\s*\\(|CREATE (?:UNIQUE )?INDEX ${identifier} ON ${table}\\b|ALTER TABLE (?:ONLY )?${table}\\s+(?:ADD (?:COLUMN |CONSTRAINT )|ALTER COLUMN ${identifier} ADD GENERATED ALWAYS AS IDENTITY\\s*\\())`, "i");
    for (const item of items) {
        const code = item.replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, " ").trim();
        if (!allowed.test(code)) throw new Error(`Unsupported SQL statement: ${code.slice(0, 90)}`);
        if (/\b(?:drop|truncate|delete|update|insert|merge|copy|execute|call|do|begin|commit|rollback|savepoint|release|vacuum|cluster|reindex|concurrently|create\s+database|alter\s+system|set|reset|attach|detach)\b/i.test(code.replace(/ON DELETE (?:SET NULL|CASCADE|RESTRICT|NO ACTION|SET DEFAULT)/gi, ""))) {
            throw new Error("Destructive, procedural, transaction-control or nontransactional SQL is forbidden");
        }
        if (/\b(?:schema_migrations|_prisma_migrations)\b/i.test(code)) throw new Error("Migration bookkeeping is reserved for the runner");
        if (/\bIF NOT EXISTS\b/i.test(code)) throw new Error("IF NOT EXISTS can conceal drift and is unsupported");
    }
}

export async function discover(directory: string): Promise<Migration[]> {
    const names = await readdir(directory);
    const migrations: Migration[] = [];
    for (const filename of names.filter(name => /\.sql$/i.test(name)).sort()) {
        const match = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/.exec(filename);
        if (!match) throw new Error(`Invalid migration filename: ${filename}`);
        const version = Number(match[1]);
        const sql = await readFile(path.join(directory, filename), "utf8");
        if (version !== migrations.length + 1) throw new Error(`Missing or duplicate version before ${filename}`);
        migrations.push({ version, filename, checksum: checksum(sql), sql });
    }
    if (migrations[0]?.filename !== "0001_initial_schema.sql") throw new Error("Expected 0001_initial_schema.sql baseline");
    return migrations;
}

export function pending(migrations: Migration[], applied: AppliedMigration[]): Migration[] {
    for (let i = 0; i < applied.length; i++) {
        const row = applied[i];
        const local = migrations[i];
        if (row.version !== i + 1 || !local || row.filename !== local.filename || row.checksum !== local.checksum || !row.applied_at) {
            throw new Error(`Inconsistent history at version ${row.version}: missing, renamed or modified migration`);
        }
    }
    return migrations.slice(applied.length);
}

// Compare pg_dump's complete public schema DDL, preserving quoted text. Only
// dump settings and the two explicitly named bookkeeping tables are excluded.
export function canonicalSchema(sql: string): string {
    const withoutMeta = sql.split("\n").filter(line => !/^\\(?:un)?restrict\b/.test(line)).join("\n");
    const items = statements(withoutMeta).filter(item => {
        if (/^(?:SET |SELECT pg_catalog\.set_config\()/i.test(item)) return false;
        if (/^(?:CREATE SCHEMA public\b|COMMENT ON SCHEMA public\b)/i.test(item)) return false;
        if (/^(?:CREATE TABLE|ALTER TABLE(?: ONLY)?) public\.(?:_prisma_migrations|schema_migrations)\s/i.test(item)) return false;
        return true;
    });
    return items.map(item => item.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\s+/g, token => /^\s+$/.test(token) ? " " : token).trim()).sort().join(";\n");
}
