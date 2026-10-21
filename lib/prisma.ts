import { databaseConnectionString } from "../scripts/runtime-config";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: databaseConnectionString(),
});

export const prisma = new PrismaClient({
  adapter,
});