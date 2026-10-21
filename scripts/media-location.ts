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
    const url = new URL("http://127.0.0.1:8088/reverse");

    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(processingSignal() ? [processingSignal()!] : [])]) });

    if (!response.ok) {
        throw new Error(
            `Nominatim request failed: ${response.status} ${response.statusText}`
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

    const address = data.address;

    if (!address) {
        return {};
    }

    const city =
        address.city ??
        address.town ??
        address.village ??
        address.municipality;

    return {
        city,
        country: address.country,
    };

}