// TEMPORARY diagnostic: is the OpenCode model list empty on Linux because of the server side or the page?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOpenCode, openCodeModels } from '../src/opencode-bin.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.OPENCODE_BIN = path.join(APP, 'test-support', 'fake-acp.mjs');
const bin = findOpenCode();
console.log('bin:', JSON.stringify(bin));
const models = await openCodeModels(bin);
console.log('models:', JSON.stringify(models));
process.exit(0);
