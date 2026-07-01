// Resolves which endpoint(s) a command targets, from --endpoint / --tag / --all.
// Returns [{ method, path, operation }] using the same spec readers the browser
// app uses (getEndpointsByTag / getOperation), so the CLI sees identical endpoints.

import { getEndpointsByTag } from '../../scripts/core/swagger-loader.js';
import { getOperation } from '../../scripts/core/template-matcher.js';
import { UsageError } from './errors.js';

// Parse an --endpoint argument like "GET /me/profile" → { method, path }.
// Accepts an optional method (defaults are not assumed — method is required so
// e.g. a path served by several verbs is unambiguous).
export function parseEndpointArg(arg) {
  const trimmed = String(arg).trim();
  const m = trimmed.match(/^([A-Za-z]+)\s+(\/.*)$/);
  if (!m) {
    throw new UsageError(`Invalid --endpoint "${arg}". Expected "<METHOD> <path>", e.g. "GET /me/profile".`);
  }
  return { method: m[1].toUpperCase(), path: m[2] };
}

/**
 * Resolve the target endpoints for a command.
 *
 * @param {object} ctx  - CLI context (ctx.spec must be loaded via useSwagger)
 * @param {{endpoint?:string, tag?:string, all?:boolean}} opts
 * @returns {Array<{method, path, operation}>}
 */
export function selectEndpoints(ctx, { endpoint, tag, all } = {}) {
  const spec = ctx.spec;
  if (!spec) throw new Error('No swagger selected — call ctx.useSwagger() first.');

  if (endpoint) {
    const { method, path } = parseEndpointArg(endpoint);
    const operation = getOperation(spec, path, method);
    if (!operation) throw new UsageError(`Endpoint not found in spec: ${method} ${path}`);
    return [{ method, path, operation }];
  }

  if (tag || all) {
    const out = [];
    for (const { path, methods } of getEndpointsByTag(spec, tag || null)) {
      for (const method of methods) {
        const operation = getOperation(spec, path, method);
        if (operation) out.push({ method, path, operation });
      }
    }
    if (!out.length) {
      throw new UsageError(tag ? `No endpoints found for tag "${tag}".` : 'No endpoints found in spec.');
    }
    return out;
  }

  throw new UsageError('Specify a target: --endpoint "<METHOD> <path>", --tag <name>, or --all.');
}
