import { databaseConnectionString, geocoderConfiguration } from "./runtime-config";
import { storageConfiguration } from "./storage-safety";
import { processingLimits } from "./processing-limits";

export function validateRuntimeConfiguration() {
    databaseConnectionString();
    storageConfiguration();
    geocoderConfiguration();
    processingLimits();
}
