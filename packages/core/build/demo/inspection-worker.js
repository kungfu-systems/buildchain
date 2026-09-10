import { inspectRendererMedia } from "./media-inspection.js";
// Runs inside the immutable network-disabled renderer with read-only runtime and media mounts.
const request = JSON.parse(process.argv[2]);
inspectRendererMedia(request);
