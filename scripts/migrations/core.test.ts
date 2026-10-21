import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalSchema, checksum, discover, pending, pgDumpEnvironment, statements, validateSql, type AppliedMigration } from "./core";

test("pg_dump omits service variables instead of passing empty libpq settings", () => {
    for (const service of [undefined, "", "unexpected_service"]) {
        const parent: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin", PGSERVICE: service, PGSERVICEFILE: "", PGPASSWORD: "inherited", PGOPTIONS: "unsafe", PGSSLMODE: "" };
        const env = pgDumpEnvironment(parent, new URL("postgresql://user@127.0.0.1:55439/gallery_test?sslmode="));
        for (const name of ["PGSERVICE", "PGSERVICEFILE", "PGPASSWORD"]) assert.equal(Object.hasOwn(env, name), false);
        assert.equal(env.PGSSLMODE, "prefer");
        assert.equal(env.PGOPTIONS, "-c default_transaction_read_only=on");
        assert.equal(env.PATH, parent.PATH);
        assert.equal(parent.PGPASSWORD, "inherited");
        assert.equal(parent.PGSERVICE, service);
    }
    const explicit = pgDumpEnvironment({ NODE_ENV: "test" }, new URL("postgresql://user:p%40ss@127.0.0.1:55439/gallery_test?sslmode=verify-full"));
    assert.equal(explicit.PGPASSWORD, "p@ss");
    assert.equal(explicit.PGSSLMODE, "verify-full");
});

test("permanent baseline is unchanged and admitted by the migration policy", async () => {
    const baseline = await readFile(new URL("../../db/migrations/0001_initial_schema.sql", import.meta.url), "utf8");
    // Pin the validated, adopted file, including its historical source comments.
    // Future schema changes belong in new migrations, not a new checksum here.
    assert.equal(checksum(baseline), "6181932f29aef0d7e29ad3892e4cffdc56e352114eb7f68525224eb44c18f192");
    validateSql(baseline);
    assert.equal(statements(baseline).length, 32);
});

test("reject unsupported or transaction-escaping SQL, including disguised commands", () => {
    for (const sql of [
        "DROP TABLE public.media;", "BEGIN; CREATE TABLE public.a(id int); COMMIT;",
        "CREATE INDEX CONCURRENTLY media_idx ON public.media(media_id);",
        "ALTER TABLE public.media ADD COLUMN x int, DROP COLUMN file_name;",
        "DO $$ BEGIN END $$;", "COPY public.media FROM PROGRAM 'command';",
        "CREATE TABLE public.schema_migrations(id int);", 'CREATE TABLE public."schema_migrations"(id int);',
        "CREATE TABLE IF NOT EXISTS public.a(id int);", "VACUUM;", "SELECT 1;",
        "CREATE TABLE public.a(id int); /* nested /* comment */ */ COMMIT;",
        "CREATE TABLE public.a(id int)", "CREATE TABLE public.a(x text DEFAULT 'unterminated);",
    ]) assert.throws(() => validateSql(sql), sql);
    validateSql("CREATE TABLE public.a(x text DEFAULT 'DROP; COMMIT;');");
    validateSql("ALTER TABLE public.a ADD COLUMN label text;");
    assert.equal(statements("-- comment\nCREATE TABLE public.a(x text DEFAULT 'a;''b');").length, 1);
});

test("history must be an exact immutable prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gallery-migration-unit-"));
    try {
        await writeFile(path.join(dir, "0001_initial_schema.sql"), "CREATE TABLE public.a(id int);\n");
        await writeFile(path.join(dir, "0002_add_label.sql"), "ALTER TABLE public.a ADD COLUMN label text;\n");
        const migrations = await discover(dir);
        const first = { ...migrations[0], applied_at: new Date() };
        assert.deepEqual(pending(migrations, [first]), [migrations[1]]);
        for (const edit of [{ checksum: checksum("changed") }, { filename: "0001_renamed.sql" }, { version: 2 }, { applied_at: null }]) {
            assert.throws(() => pending(migrations, [{ ...first, ...edit } as AppliedMigration]));
        }
        assert.throws(() => pending(migrations, [first, { ...first, version: 3 }]));
        await rm(path.join(dir, "0002_add_label.sql"));
        await writeFile(path.join(dir, "0003_gap.sql"), "CREATE TABLE public.b(id int);");
        await assert.rejects(discover(dir), /Missing or duplicate/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("schema canonicalization excludes bookkeeping but retains semantic differences", () => {
    const ddl = "CREATE TABLE public.a(label text DEFAULT 'two  spaces');";
    assert.equal(canonicalSchema(ddl), canonicalSchema("SET row_security = off;\n" + ddl));
    for (const table of ["_prisma_migrations", "schema_migrations"]) {
        const bookkeeping = `CREATE TABLE public.${table} (id text NOT NULL); ALTER TABLE ONLY public.${table} ADD CONSTRAINT ledger_pkey PRIMARY KEY (id);`;
        assert.equal(canonicalSchema(ddl), canonicalSchema(ddl + bookkeeping));
    }
    assert.notEqual(canonicalSchema(ddl), canonicalSchema(ddl.replace("two  spaces", "two spaces")));
    assert.notEqual(canonicalSchema(ddl), canonicalSchema(ddl + "CREATE TABLE public.extra(id int);"));
    assert.notEqual(canonicalSchema(ddl), canonicalSchema(ddl.replace("text", "varchar(10)")));
});

test("CLI rejects missing targets and unconfirmed writes before connecting", () => {
    const cases = [
        { args: ["status"], url: "", message: "Set GALLERY_MIGRATION_URL" },
        { args: ["status"], url: "postgresql://user:secret@127.0.0.1:5432/postgres", message: "maintenance databases" },
        { args: ["status", "--host", "elsewhere"], url: "postgresql://user:secret@127.0.0.1:5432/gallery_test", message: "--host must match" },
        { args: ["init", "--host", "127.0.0.1", "--port", "5432", "--database", "gallery_test"], url: "postgresql://user:secret@127.0.0.1:5432/gallery_test", message: "Writes require --confirm" },
    ];
    for (const item of cases) {
        const env: NodeJS.ProcessEnv = { ...process.env, GALLERY_MIGRATION_URL: item.url };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrations/run.ts", ...item.args], {
            env, encoding: "utf8", timeout: 10000,
        });
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(item.message), JSON.stringify({ expected: item.message, stdout: result.stdout, stderr: result.stderr }));
        assert.ok(!result.stderr.includes("secret"));
    }
});
