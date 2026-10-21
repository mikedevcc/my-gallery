import { geocoderConfiguration } from "./runtime-config";
import { ProcessingError, processingSignal } from "./processing-limits";
export type ResolvedLocation = {
    city?: string;
    country?: string;
};

type NominatimAddress = {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    country?: string;
};

type NominatimReverseResponse = {
    address?: NominatimAddress;
};

export async function resolveLocation(
    latitude: number,
    longitude: number
): Promise<ResolvedLocation> {
    const config = geocoderConfiguration();
    if (config.mode === "disabled") return {};
    const signal = processingSignal();
    if (signal?.aborted) throw new ProcessingError("Geocoding cancelled", 408);
    const deadline = AbortSignal.timeout(config.timeoutMs);
    try {
        const url = new URL(config.url!);

        url.searchParams.set("lat", String(latitude));
        url.searchParams.set("lon", String(longitude));
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");

        const response = await fetch(url, { signal: AbortSignal.any([deadline, ...(signal ? [signal] : [])]) });

        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error(
                `Geocoder returned HTTP ${response.status}`
            );
        }

        if (!response.body) throw new ProcessingError("Empty geocoder response", 502);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let data: NominatimReverseResponse;
        try {
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                bytes += result.value.byteLength;
                if (bytes > 65536) throw new ProcessingError("Geocoder response exceeds limit", 502);
                chunks.push(result.value);
            }
            data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NominatimReverseResponse;
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }

        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid geocoder response");
        const address = data.address;
        if (address && (typeof address !== "object" || Array.isArray(address) || Object.values(address).some(value => typeof value !== "string"))) throw new Error("Invalid geocoder address");

        if (!address) {
            return {};
        }

        const city =
            address.city ??
            address.town ??
            address.village ??
            address.municipality;

        return { city, country: address.country };
    } catch {
        // Never propagate fetch errors containing URLs, credentials or response bodies.
        if (signal?.aborted) throw new ProcessingError("Geocoding cancelled", 408);
        if (config.mode === "best-effort") return {};
        throw new ProcessingError(deadline.aborted ? "Geocoder request timed out" : "Geocoder request failed", deadline.aborted ? 504 : 502);
    }

}