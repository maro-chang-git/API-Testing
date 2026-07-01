// CLI bootstrap — the Node equivalent of app.js's init + onSwaggerChange, minus
// the DOM. Installs the filesystem fetch shim, then loads the config, the
// swagger manifest and the template library through the same core modules the
// browser uses. A swagger spec + its specs.json model are loaded lazily via
// useSwagger() so discovery commands (e.g. `list`) don't pay for parsing a spec.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { installFsFetch } from './fs-fetch.js';
import { loadManifest, loadSwagger } from '../../scripts/core/swagger-loader.js';
import { loadConfig } from '../../scripts/core/config-loader.js';
import * as specsStore from '../../scripts/specs-store.js';
import { UsageError } from '../lib/errors.js';

// The project root is the "API Testing" directory: <root>/cli/runtime/context.js
// → ../../. A `--cwd` flag overrides it (e.g. to run against another checkout).
export function resolveProjectRoot(cwdFlag) {
  return cwdFlag ? path.resolve(cwdFlag) : fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * Builds the shared CLI context. Loads config + manifest + templates eagerly
 * (cheap, always needed); the spec is loaded on demand by ctx.useSwagger().
 *
 * @param {{cwd?: string}} opts
 * @returns context: { projectRoot, manifest, templates, specsStore, entry, spec, useSwagger }
 */
export async function createContext({ cwd } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  installFsFetch(projectRoot);

  // loadConfig() resolves to nothing — it populates config-loader's module
  // state (read app-wide via getConfig()). Kick it off alongside the data
  // fetches, then await it before any module reads the config.
  const configReady = loadConfig();
  const [manifest, templatesData] = await Promise.all([
    loadManifest(),
    readFile(path.join(projectRoot, 'data', 'templates.json'), 'utf8').then(JSON.parse),
  ]);
  await configReady;

  const ctx = {
    projectRoot,
    manifest,
    templates: templatesData.templates,
    specsStore,
    entry: null,
    spec: null,

    // Selects a swagger by id (or the first when omitted), loads + dereferences
    // its spec, and loads/scaffolds its specs.json model — exactly what
    // app.js#onSwaggerChange does. Sets ctx.entry / ctx.spec and returns ctx.
    async useSwagger(id) {
      if (!manifest.length) throw new Error('No swaggers found in swaggers/index.json');
      const entry = id ? manifest.find((m) => m.id === id) : manifest[0];
      if (!entry) {
        throw new UsageError(`Swagger '${id}' not found. Available: ${manifest.map((m) => m.id).join(', ')}`);
      }
      ctx.entry = entry;
      ctx.spec = await loadSwagger(entry.file);
      await specsStore.loadOrScaffoldSpecs(entry, ctx.spec);
      return ctx;
    },
  };

  return ctx;
}
