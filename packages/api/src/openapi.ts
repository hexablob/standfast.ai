/**
 * Emits the OpenAPI document to stdout.
 *
 * The result is committed at infra/openapi/openapi.json and CI re-runs this
 * and fails on a diff. The committed artifact is what makes an accidental
 * breaking change visible in review rather than at a customer's integration.
 */
import { createApp, openApiDocument } from "./app.js";

const app = createApp();
const document = app.getOpenAPIDocument(openApiDocument);

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
