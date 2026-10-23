import { mediaFormat, unsupportedMediaMessage } from "../lib/media-formats";
import { validateMediaContents } from "./media-format-validation";
import { ProcessingError } from "./processing-limits";
import { captureDateFromExif } from "../lib/media-capture-date";
import { assertMediaInputPath } from "./media-paths";
import "dotenv/config";
import { validateStorage } from "./storage-safety";

import path from "node:path";
import fs from "node:fs/promises";
import { runMediaSubprocess } from "./media-subprocess";






type ExifData = Record<string, unknown>;


type MediaFileInfo = {
    fileName: string;
    absolutePath: string;
    extension: string;
    fileSize: number;
    fileType: "IMAGE" | "VIDEO";
};


type MediaMetadata = {
    dateTaken?: Date;
    captureLocal?: string;
    captureOffsetMinutes?: number;
    width?: number;
    height?: number;
    latitude?: number;
    longitude?: number;
};


type ImageNumericMetadata = {
    iso?: number;
    aperture?: number;
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


type VideoMetadata = {
    durationSeconds?: number;
    frameRate?: number;
    bitrate?: number;
    videoCodec?: string;
    audioCodec?: string;
}


export type ImportedMedia = {
    file: MediaFileInfo;
    media: MediaMetadata;
    image?: ImageMetadata;
    video?: VideoMetadata;

    fileModifiedAt?: Date | null;
    fileModifiedTimezone?: string | null;
};





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


async function runExifTool(
    filePath: string,
    args: string[]
): Promise<ExifData> {
    const storage = await validateStorage();
    await storage.assertAvailable(filePath);
    const { stdout } = await runMediaSubprocess("exiftool", [...args, filePath]);
    await storage.assertAvailable(filePath);

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

    return firstResult as ExifData;
}


function readMediaMetadataExif(
    metadata: ExifData
): MediaMetadata {

    return {
        ...captureDateFromExif(metadata),
        width: getNumber(metadata, "ImageWidth"),
        height: getNumber(metadata, "ImageHeight"),
        latitude: getNumber(metadata, "GPSLatitude"),
        longitude: getNumber(metadata, "GPSLongitude"),
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
    
    const storage = await validateStorage();
    assertMediaInputPath(storage.root, filePath);
    await storage.assertAvailable(absolutePath);
    const stats = await fs.stat(absolutePath);
    await storage.assertAvailable(absolutePath);

    // validate existence
    if (!stats.isFile()) {
        throw new Error("Path is not a file.");
    }
    
    const format = mediaFormat(fileName);
    if (!format) throw new ProcessingError(unsupportedMediaMessage, 415);
    const fileType = format.kind;

    return {
        fileName,
        absolutePath,
        extension,
        // get exact file size
        fileSize: stats.size,
        fileType,
    };
}


async function readImageNumericExif(
    filePath: string
): Promise<ImageNumericMetadata> {
    const args = ["-json", "-n"];
    const metadata = await runExifTool(filePath, args);

    return {
        iso: getNumber(metadata, "ISO"),
        aperture: getNumber(metadata, "Aperture"),
        exposureTime: getNumber(metadata, "ExposureTime"),
        focalLengthMm: getNumber(metadata, "FocalLength"),
        focalLength35mm: getNumber(metadata, "FocalLengthIn35mmFormat"),
    };
}


async function readImageStringExif(
    filePath: string
): Promise<ImageStringMetadata> {
    const args = ["-json", "-Flash", "-WhiteBalance"];
    const metadata = await runExifTool(filePath, args);

    return {
        flash: getString(metadata, "Flash"),
        whiteBalance: getString(metadata, "WhiteBalance"),
    };
}


async function readImageExif(
    filePath: string
): Promise<ImageMetadata> {
    const imageNumericMetadata = await readImageNumericExif(filePath);
    const imageStringMetadata = await readImageStringExif(filePath);

    return {...imageNumericMetadata, ...imageStringMetadata};
}


async function readVideoExif(
    filePath: string
): Promise<VideoMetadata> {
    const args = ["-json", "-n"];
    const metadata = await runExifTool(filePath, args);

    return {
        durationSeconds: getNumber(metadata, "Duration"),
        frameRate: getNumber(metadata, "VideoFrameRate"),
        bitrate: getNumber(metadata, "AvgBitrate"),
        videoCodec: getString(metadata, "CompressorID"),
        audioCodec: getString(metadata, "AudioFormat"),
    };
}


export async function importMedia(
    filePath: string
): Promise<ImportedMedia> {
    const mediaFileInfo = await inspectMediaFile(filePath);

    const absolutePath = mediaFileInfo.absolutePath;
    let metadata: ExifData;
    try {
        metadata = await runExifTool(absolutePath, ["-json", "-n"]);
    } catch (error) {
        if (error instanceof ProcessingError && error.status === 422) throw new ProcessingError(unsupportedMediaMessage, 415);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProcessingError("Media metadata tool unavailable", 503);
        throw error;
    }
    const storage = await validateStorage();
    await storage.assertAvailable(absolutePath);
    await validateMediaContents(absolutePath, mediaFormat(mediaFileInfo.fileName)!, metadata);
    await storage.assertAvailable(absolutePath);

    return {
        file: mediaFileInfo,
        media: readMediaMetadataExif(metadata),
        image: 
            mediaFileInfo.fileType === "IMAGE"
                ? await readImageExif(absolutePath)
                : undefined,
        video:
            mediaFileInfo.fileType === "VIDEO"
            ? await readVideoExif(absolutePath)
            : undefined
    }
}
