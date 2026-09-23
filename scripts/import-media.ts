import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);


type MediaFileInfo = {
    fileName: string;
    absolutePath: string;
    extension: string;
    fileSize: number;
    fileType: "IMAGE" | "VIDEO";
};


type MediaDateInfo = {
    dateTaken?: Date;
}


type MediaInfo = 
    MediaFileInfo &
    MediaDateInfo


type ImageNumericMetadata = {
    width?: number;
    height?: number;
    iso?: number;
    aperture?: number;
    latitude?: number;
    longitude?: number;
    exposureTime?: number;
    focalLengthMm?: number;
    focalLength35mm?: number;
};


type ImageStringMetadata = {
    flash?: string;
    whiteBalance?: string;
};


type ImageMetadata = 
    ImageNumericMetadata & 
    ImageStringMetadata;


type ExifData = Record<string, unknown>;


const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".svg", ".heif", ".tiff", ".raw", ".webp", ".avif"];
const videoExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv"];


function getNumber(
    metadata: ExifData,
    key: string
): number | undefined {
    const value = metadata[key];

    return typeof value === "number"
        ? value
        : undefined;
}

function getString(
    metadata: ExifData,
    key: string
): string | undefined {
    const value = metadata[key];

    return typeof value === "string"
        ? value
        : undefined;
}


async function readDateExif(
    filePath: string
): Promise<MediaDateInfo> { 
    const { stdout } = await execFileAsync("exiftool", [
        "-json",
        "-SubSecDateTimeOriginal",
        filePath,
    ]);

    const parsed: unknown = JSON.parse(stdout);

    if (!Array.isArray(parsed)) {
        throw new Error("ExifTool returned invalid JSON structure");
    }

    if (parsed.length === 0) {
        throw new Error("ExifTool returned no metadata");
    }

    const firstResult = parsed[0];

    if (
        typeof firstResult !== "object" ||
        firstResult === null ||
        Array.isArray(firstResult)
    ) {
        throw new Error("ExifTool metadata entry is not an object");
    }

    const metadata = firstResult as ExifData;

    const raw = String(metadata["SubSecDateTimeOriginal"]);

    if (raw === undefined) {
        return {
            dateTaken: undefined,
        };
    }

    const iso = raw.replace(
        /^(\d{4}):(\d{2}):(\d{2}) /,
        "$1-$2-$3T"
    );

    const dateTime = new Date(iso)

    return {
        dateTaken: Number.isNaN(dateTime.getTime())
        ? dateTime
        : undefined,
    }
}


async function inspectMediaFile(
    filePath: string
): Promise<MediaFileInfo> {
    // resolve absolute path
    const absolutePath = path.resolve(filePath);
    // get filename
    const fileName = path.basename(absolutePath);
    // get extension
    const extension = path.extname(absolutePath).toLowerCase();
    
    const stats = await fs.stat(absolutePath);

    // validate existence
    if (!stats.isFile()) {
        throw new Error("Path is not a file.");
    }
    
    // validate and determine file type
    let fileType: "IMAGE" | "VIDEO";

    if (imageExtensions.includes(extension)) {
        fileType = "IMAGE";
    }
    else if (videoExtensions.includes(extension)) {
        fileType = "VIDEO";
    }
    else {
        throw new Error("Unsupported file type");
    }

    return {
        fileName,
        absolutePath,
        extension,
        // get exact file size
        fileSize: stats.size,
        fileType,
    };
}


async function inspectMedia(
    filePath: string
): Promise<MediaInfo> {
    const fileInfo = await inspectMediaFile(filePath);
    const dateInfo = await readDateExif(fileInfo.absolutePath);

    return {
        ...fileInfo,
        ...dateInfo,
    };
}


async function readNumericExif(
    filePath: string
): Promise<ImageNumericMetadata> {
    const { stdout } = await execFileAsync("exiftool", [
        "-json",
        "-n",
        filePath,
    ]);

    const parsed: unknown = JSON.parse(stdout);

    if (!Array.isArray(parsed)) {
        throw new Error("ExifTool returned invalid JSON structure");
    }

    if (parsed.length === 0) {
        throw new Error("ExifTool returned no metadata");
    }

    const firstResult = parsed[0];

    if (
        typeof firstResult !== "object" ||
        firstResult === null ||
        Array.isArray(firstResult)
    ) {
        throw new Error("ExifTool metadata entry is not an object");
    }

    const metadata = firstResult as ExifData;

    return {
        width: getNumber(metadata, "ImageWidth"),
        height: getNumber(metadata, "ImageHeight"),
        iso: getNumber(metadata, "ISO"),
        aperture: getNumber(metadata, "Aperture"),
        latitude: getNumber(metadata, "GPSLatitude"),
        longitude: getNumber(metadata, "GPSLongitude"),
        exposureTime: getNumber(metadata, "ExposureTime"),
        focalLengthMm: getNumber(metadata, "FocalLength"),
        focalLength35mm: getNumber(metadata, "FocalLengthIn35mmFormat"),
    };
}


async function readStringExif(
    filePath: string
): Promise<ImageStringMetadata> {
    const { stdout } = await execFileAsync("exiftool", [
        "-json",
        "-Flash",
        "-WhiteBalance",
        filePath,
    ]);

    const parsed: unknown = JSON.parse(stdout);

    if (!Array.isArray(parsed)) {
        throw new Error("ExifTool returned invalid JSON structure");
    }

    if (parsed.length === 0) {
        throw new Error("ExifTool returned no metadata");
    }

    const firstResult = parsed[0];

    if (
        typeof firstResult !== "object" ||
        firstResult === null ||
        Array.isArray(firstResult)
    ) {
        throw new Error("ExifTool metadata entry is not an object");
    }

    const metadata = firstResult as ExifData;

    return {
        flash: getString(metadata, "Flash"),
        whiteBalance: getString(metadata, "WhiteBalance"),
    };
}


async function readExif(
    filePath: string
): Promise<ImageMetadata> {
    const imageNumericMetadata = await readNumericExif(filePath);
    const imageStringMetadata = await readStringExif(filePath);

    return {...imageNumericMetadata, ...imageStringMetadata};
}


async function main() {
    const media = await inspectMediaFile(
        "../../../Pictures/IMG_20260922_200308.jpg"
    );

    const date = await readDateExif(media.absolutePath);
    
    console.log(date)

    const metadata = await readExif(media.absolutePath);

    console.log(metadata);
}

main();