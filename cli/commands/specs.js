// `specs get|set` — read or edit output/{id}/specs.json (the per-swagger model
// that overrides spec/config defaults). Reuses the specs-store setters + saveSpecs
// the browser uses, so edits are written exactly like Save Specs in the UI.

import { parseEndpointArg } from '../lib/endpoint-select.js';
import { readBodyArg, parseHeaderFlags } from '../lib/read-input.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { getOperation } from '../../scripts/core/template-matcher.js';
import { REQUEST_TYPES } from '../../scripts/core/request-types.js';
import { RESPONSE_BODY_TYPES } from '../../scripts/core/response-body-types.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

const VALID_REQUEST_TYPES = REQUEST_TYPES.map((t) => t.key);
const VALID_RESPONSE_TYPES = RESPONSE_BODY_TYPES.map((t) => t.key);

function endpointTarget(ctx, args) {
  if (!args.endpoint) throw new UsageError('This setting is per-endpoint — pass --endpoint "<METHOD> <path>".');
  const { method, path } = parseEndpointArg(args.endpoint);
  if (!getOperation(ctx.spec, path, method)) throw new UsageError(`Endpoint not found: ${method} ${path}`);
  return { method, path };
}

async function runGet(ctx, args, logger) {
  logger.banner(`specs get — ${ctx.entry.id}${args.endpoint ? `  ${args.endpoint}` : ''}`);
  const ss = ctx.specsStore;
  const swagger = {
    baseUrl: ss.effectiveBaseUrl(ctx.spec),
    auth: ss.effectiveAuth(),
    headers: ss.effectiveHeaders(),
  };
  const result = { swagger: ctx.entry.id, ...swagger };

  if (args.endpoint) {
    const { method, path } = endpointTarget(ctx, args);
    const op = getOperation(ctx.spec, path, method);
    const { profile } = deriveEndpointCases(method, path, op, ctx.spec, ss, ctx.templates);
    result.endpoint = {
      target: `${method} ${path}`,
      authRequired: profile.auth_required,
      requestType: profile.request_type,
      responseBodyType: profile.response_body_type,
      sseDialect: profile.sse_dialect,
      headerParams: ss.effectiveHeaderParams(method, path, op),
      pathParams: ss.effectivePathParams(method, path),
      requestBody: ss.effectiveRequestBody(method, path, op, ctx.spec),
    };
  }

  logger.result(result, () => {
    logger.out(color.bold(`Specs — ${ctx.entry.id}`));
    logger.out(`  baseUrl : ${swagger.baseUrl}`);
    logger.out(`  auth    : ${swagger.auth.type} (${swagger.auth.in})  token=${swagger.auth.token ? '<set>' : '<empty>'}`);
    logger.out(`  headers : accept=${swagger.headers.accept}  content-type=${swagger.headers.contentType}`);
    if (result.endpoint) {
      const e = result.endpoint;
      logger.out('');
      logger.out(color.bold(`  ${e.target}`));
      logger.out(`    authRequired     : ${e.authRequired}`);
      logger.out(`    requestType      : ${e.requestType}`);
      logger.out(`    responseBodyType : ${e.responseBodyType}${e.sseDialect ? ` (${e.sseDialect})` : ''}`);
      logger.out(`    headerParams     : ${JSON.stringify(e.headerParams)}`);
    }
  });
  return 0;
}

async function runSet(ctx, args, logger) {
  logger.banner(`specs set — ${ctx.entry.id}`);
  const ss = ctx.specsStore;
  const changes = [];

  // Swagger-level settings.
  if (args['base-url'] !== undefined) { ss.setBaseUrl(args['base-url']); changes.push(`baseUrl=${args['base-url']}`); }
  if (args.token !== undefined) { ss.setAuthToken(args.token); changes.push('token=<set>'); }

  // Endpoint-level settings (resolved lazily, only if one was requested).
  const wantsEndpointSet = ['request-type', 'response-type', 'auth-required'].some((k) => args[k] !== undefined)
    || (args.header && args.header.length) || args.body !== undefined;

  if (wantsEndpointSet) {
    const { method, path } = endpointTarget(ctx, args);

    if (args['request-type'] !== undefined) {
      if (!VALID_REQUEST_TYPES.includes(args['request-type'])) {
        throw new UsageError(`Invalid --request-type "${args['request-type']}". One of: ${VALID_REQUEST_TYPES.join(', ')}`);
      }
      ss.setRequestType(method, path, args['request-type']); changes.push(`requestType=${args['request-type']}`);
    }
    if (args['response-type'] !== undefined) {
      if (!VALID_RESPONSE_TYPES.includes(args['response-type'])) {
        throw new UsageError(`Invalid --response-type "${args['response-type']}". One of: ${VALID_RESPONSE_TYPES.join(', ')}`);
      }
      ss.setResponseBodyType(method, path, args['response-type']); changes.push(`responseBodyType=${args['response-type']}`);
    }
    if (args['auth-required'] !== undefined) {
      const val = /^(true|1|yes)$/i.test(args['auth-required']);
      ss.setAuthRequired(method, path, val); changes.push(`authRequired=${val}`);
    }
    if (args.header && args.header.length) {
      const map = parseHeaderFlags(args.header);
      ss.setHeaderParams(method, path, map); changes.push(`headerParams=${JSON.stringify(map)}`);
    }
    if (args.body !== undefined) {
      const raw = await readBodyArg(args.body, ctx.projectRoot);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new UsageError('--body must be valid JSON.'); }
      ss.setRequestBody(method, path, parsed); changes.push('requestBody=<set>');
    }
  }

  if (!changes.length) throw new UsageError('Nothing to set. Provide e.g. --token, --base-url, --request-type, --header.');

  const saved = await ss.saveSpecs();
  logger.result(
    { swagger: ctx.entry.id, saved, changes },
    () => {
      logger.out(`${saved ? color.green('✓ Saved') : color.yellow('Saved (offline cache)')} output/${ctx.entry.id}/specs.json`);
      for (const c of changes) logger.out(`  ${color.dim('•')} ${c}`);
    },
  );
  return 0;
}

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const sub = args._[1] || 'get';
  if (sub === 'get') return runGet(ctx, args, logger);
  if (sub === 'set') return runSet(ctx, args, logger);
  throw new UsageError(`Unknown "specs ${sub}". Use "specs get" or "specs set".`);
}
