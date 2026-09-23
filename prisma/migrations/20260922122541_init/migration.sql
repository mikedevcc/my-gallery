-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "previewPath" TEXT,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "dateTaken" TIMESTAMP(3),
    "dateImported" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "altitudeM" DOUBLE PRECISION,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "locationName" TEXT,
    "cameraMake" TEXT,
    "cameraModel" TEXT,
    "focalLengthMm" DOUBLE PRECISION,
    "focalLength35mm" DOUBLE PRECISION,
    "aperture" DOUBLE PRECISION,
    "iso" INTEGER,
    "exposureTime" TEXT,
    "flash" TEXT,
    "whiteBalance" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Photo_originalPath_key" ON "Photo"("originalPath");
