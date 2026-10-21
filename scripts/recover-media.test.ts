import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

test("recovery CLI rejects unconfirmed/unexpected targets before connecting", () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    const base = [id, "--host", "127.0.0.1", "--port", "55439", "--database", "h4c_replacement_test_fixture", "--confirm-installation", id];
    for (const item of [
        { args: [], url: "", installation: id, error: "Usage:" },
        { args: base, url: "postgresql://user:secret@127.0.0.1:55439/h4c_replacement_test_fixture", installation: "wrong", error: "installation confirmation" },
        { args: base, url: "postgresql://user:secret@127.0.0.1:55439/mygallery", installation: id, error: "Unexpected recovery database target" },
        { args: base, url: "postgresql://user:secret@127.0.0.1:55439/postgres", installation: id, error: "Unexpected recovery database target" },
    ]) {
        const env: NodeJS.ProcessEnv = { ...process.env, MEDIA_RECOVERY_DATABASE_URL: item.url, MEDIA_STORAGE_ID: item.installation };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/recover-media.ts", ...item.args], { env, encoding: "utf8", timeout: 5000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(item.error));
        assert.ok(!result.stderr.includes("secret"));
    }
});
