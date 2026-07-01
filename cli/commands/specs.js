// `specs get|set` — read or edit output/{id}/specs.json (the per-swagger model
// that overrides spec/config defaults). Reuses the specs-store setters + saveSpecs
// the browser uses, so edits are written exactly like Save Specs in the UI.

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { parseEndpointArg } from '../lib/endpoint-select.js';
import { readBodyArg, parseHeaderFlags } from '../lib/read-input.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { getOperation } from '../../scripts/core/template-matcher.js';
import { REQUEST_TYPES } from '../../scripts/core/request-types.js';
import { RESPONSE_BODY_TYPES } from '../../scripts/core/response-body-types.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

// Decode the exp claim from a JWT without verifying the signature.
function jwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp ?? null;
  } catch { return null; }
}

// When specs set --token is called, keep karate-config.js in sync so the
// Karate runner picks up the new credential immediately.  The file is
// intentionally write-once on first export, so we patch just the token/
// expiredToken lines rather than regenerating the whole file (preserving any
// hand-edits the user made to e.g. baseUrl or environment overrides).
async function syncKarateConfig(projectRoot, swaggerId, newToken, logger) {
  const cfgPath = path.join(projectRoot, 'output', swaggerId, 'karate', 'karate-config.js');
  try { await access(cfgPath, fsConstants.F_OK); } catch { return; }

  let src = await readFile(cfgPath, 'utf8');

  // Match the `token:` line (not expiredToken / invalidToken — the leading
  // whitespace + exact word "token" ensures we don't hit sub-words).
  const tokenLine = src.match(/^([ \t]+token:\s*')([^']*)('.*?)$/m);
  if (!tokenLine) return;
  const oldToken = tokenLine[2];
  if (oldToken === newToken) return;

  // Replace the active token.
  src = src.replace(/^([ \t]+token:\s*')([^']*)('.*?)$/m, `$1${newToken}$3`);

  // If the old token was a real JWT that has since expired, demote it to
  // expiredToken so TC-AUTH-003 (expired token) gets a genuine expired credential.
  const exp = jwtExp(oldToken);
  const isExpired = exp !== null && exp < Date.now() / 1000;
  if (isExpired) {
    src = src.replace(/^([ \t]+expiredToken:\s*')([^']*)('.*?)$/m, `$1${oldToken}$3`);
  }

  await writeFile(cfgPath, src, 'utf8');
  const note = isExpired ? ' (old token demoted to expiredToken)' : '';
  logger.out(`  ${color.dim('•')} karate-config.js patched${note}`);
}

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
  const auth = ss.effectiveAuth();
  const swagger = {
    baseUrl: ss.effectiveBaseUrl(ctx.spec),
    auth,
    headers: ss.effectiveHeaders(),
  };
  // Top-level convenience fields match the documented --json schema.
  // Note: authRequired is per-endpoint, not per-swagger — expose it when --endpoint is given;
  // at the swagger level we expose tokenSet (whether a credential is configured).
  const result = {
    swagger: ctx.entry.id,
    baseUrl: swagger.baseUrl,
    tokenSet: !!auth.token,
    headers: swagger.headers,
    // Full auth object for deeper inspection (token value intentionally omitted — see specs set).
    auth: { type: auth.type, in: auth.in, name: auth.name, tokenSet: !!auth.token },
  };

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
    logger.out(`  auth    : ${auth.type} (${auth.in})  token=${auth.token ? '<set>' : '<empty>'}`);
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

  if (saved && args.token !== undefined) {
    await syncKarateConfig(ctx.projectRoot, ctx.entry.id, args.token, logger);
  }

  return 0;
}

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const sub = args._[1] || 'get';
  if (sub === 'get') return runGet(ctx, args, logger);
  if (sub === 'set') return runSet(ctx, args, logger);
  throw new UsageError(`Unknown "specs ${sub}". Use "specs get" or "specs set".`);
}
