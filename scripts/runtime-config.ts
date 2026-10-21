/** Pure configuration checks: never probe a database, storage device or service. */
export class RuntimeConfigurationError extends Error {}
export type Environment = Record<string, string | undefined>;

export function positiveInteger(env: Environment, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RuntimeConfigurationError(`Invalid ${name}: expected a positive decimal integer within the supported range`);
    }
    return value;
}

export function databaseConnectionString(env: Environment = process.env): string {
    const raw = env.DATABASE_URL;
    const message = "DATABASE_URL must be an explicit PostgreSQL URL with role, host, port and database; only sslmode is supported as a query option";
    try {
        if (!raw || raw !== raw.trim() || /[\s\u0000-\u001f]/.test(raw)) throw new Error();
        const url = new URL(raw);
        const database = decodeURIComponent(url.pathname.slice(1));
        decodeURIComponent(url.password); decodeURIComponent(url.username);
        if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.hostname || !url.port
            || Number(url.port) < 1 || Number(url.port) > 65535 || !database || /[/\u0000-\u001f]/.test(database)
            || url.hash || [...url.searchParams.keys()].some(key => key !== "sslmode")
            || url.searchParams.getAll("sslmode").length > 1
            || (url.searchParams.has("sslmode") && !["disable", "require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode")!))) throw new Error();
        return raw;
    } catch { throw new RuntimeConfigurationError(message); }
}

export function geocoderConfiguration(env: Environment = process.env) {
    const mode = env.GEOCODER_MODE ?? "required";
    if (!["required", "best-effort", "disabled"].includes(mode)) throw new RuntimeConfigurationError("GEOCODER_MODE must be required, best-effort or disabled");
    const timeoutMs = positiveInteger(env, "GEOCODER_TIMEOUT_MS", 10_000, 2_147_483_647);
    const raw = env.GEOCODER_URL;
    let url: URL | undefined;
    if (raw !== undefined) {
        try {
            url = new URL(raw);
            if (raw !== raw.trim() || /[\s\u0000-\u001f]/.test(raw) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error();
        } catch { throw new RuntimeConfigurationError("GEOCODER_URL must be an absolute HTTP(S) reverse-geocoding endpoint without credentials, query or fragment"); }
    }
    if (mode !== "disabled" && !url) throw new RuntimeConfigurationError("GEOCODER_URL is required unless GEOCODER_MODE=disabled");
    return { mode, url, timeoutMs };
}
