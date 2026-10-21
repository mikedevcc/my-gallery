// Next invokes register before serving requests. Configuration only: no I/O,
// migration, recovery, pool checkout or HDD access occurs during registration.
export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { validateRuntimeConfiguration } = await import("./scripts/validate-runtime-config");
        validateRuntimeConfiguration();
    }
}
