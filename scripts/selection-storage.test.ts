
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
    restoreMediaSelection,
    saveMediaSelection,
} from "../lib/selection-storage";

const originalWindow = globalThis.window;

afterEach(() => {
    if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
    } else {
        globalThis.window = originalWindow;
    }
});

function mockWindow(
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
) {
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { sessionStorage: storage },
    });
}

test("restores a valid selection once", () => {
    const values = new Map<string, string>([
        ["trip-selection:1", JSON.stringify([1, 2, 2, 3])],
    ]);

    mockWindow({
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
    });

    assert.deepEqual(
        restoreMediaSelection("trip-selection:1"),
        [1, 2, 3]
    );

    assert.deepEqual(
        restoreMediaSelection("trip-selection:1"),
        []
    );
});

test("rejects invalid stored media IDs", () => {
    const values = new Map<string, string>([
        [
            "album-selection:5",
            JSON.stringify([1, -2, 0, "3", null, 2.5, 4]),
        ],
    ]);

    mockWindow({
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
    });

    assert.deepEqual(
        restoreMediaSelection("album-selection:5"),
        [1, 4]
    );
});

test("malformed JSON does not crash restoration", () => {
    mockWindow({
        getItem: () => "{invalid",
        setItem: () => {},
        removeItem: () => {},
    });

    assert.deepEqual(
        restoreMediaSelection("trip-selection:1"),
        []
    );
});

test("non-array JSON does not crash restoration", () => {
    mockWindow({
        getItem: () => '{"selected": [1, 2]}',
        setItem: () => {},
        removeItem: () => {},
    });

    assert.deepEqual(
        restoreMediaSelection("album-selection:1"),
        []
    );
});

test("storage exceptions do not crash restoration or saving", () => {
    mockWindow({
        getItem: () => { throw new Error("Storage blocked"); },
        setItem: () => { throw new Error("Storage blocked"); },
        removeItem: () => { throw new Error("Storage blocked"); },
    });

    assert.deepEqual(
        restoreMediaSelection("trip-selection:1"),
        []
    );

    assert.doesNotThrow(() => {
        saveMediaSelection("trip-selection:1", [1, 2]);
    });
});

test("save and restore preserve valid selection IDs", () => {
    const values = new Map<string, string>();

    mockWindow({
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
    });

    saveMediaSelection("album-selection:9", [5, 10]);

    assert.deepEqual(
        restoreMediaSelection("album-selection:9"),
        [5, 10]
    );
});
