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

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Nominatim request failed: ${response.status} ${response.statusText}`
        );
    }

    const data = await response.json() as NominatimReverseResponse;

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