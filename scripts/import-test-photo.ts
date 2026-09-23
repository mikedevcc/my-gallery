import { prisma } from "../lib/prisma";

async function main() {
  const photo = await prisma.photo.create({
    data: {
      filename: "IMG_20260922_200308.jpg",
      originalPath: "/home/mikef/Pictures/IMG_20260922_200308.jpg",

      mimeType: "image/jpeg",
      fileSizeBytes: BigInt(3_800_000),

      width: 3072,
      height: 4096,

      dateTaken: new Date("2026-09-22T20:03:08.319+08:00"),

      latitude: 1.289708,
      longitude: 103.776819,
      altitudeM: 16.2,

      cameraMake: "Xiaomi",
      cameraModel: "Xiaomi 15T",

      focalLengthMm: 5.3,
      focalLength35mm: 23,
      aperture: 1.7,
      iso: 800,
      exposureTime: "1/90",

      flash: "Off, Did not fire",
      whiteBalance: "Auto",

      favorite: false,
    },
  });

  console.log(photo);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });