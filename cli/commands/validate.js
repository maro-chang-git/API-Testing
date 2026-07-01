// `validate` — check a response body against the spec's response schema for a
// given status, without making a request. The body comes from --body @file, an
// inline string, or stdin (default). Reuses the same AJV-backed validateResponse
// the Try It tab uses.
//
// Exit code: 0 = pass / nothing-to-validate, 1 = schema failed.

import { selectEndpoints } from '../lib/endpoint-select.js';
import { validateResponse } from '../../scripts/tryit/schema-validator.js';
import { readBodyArg } from '../lib/read-input.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);
  if (targets.length > 1) throw new UsageError('`validate` checks one endpoint — narrow with --endpoint "<METHOD> <path>".');
  const { method, path, operation } = targets[0];

  const status = args.status || '200';
  logger.banner(`validate — ${ctx.entry.id}  ${method} ${path}  status:${status}`);
  // Default to stdin so `… | api-test validate …` works.
  const bodyText = await readBodyArg(args.body ?? '-', ctx.projectRoot);
  if (bodyText == null || bodyText.trim() === '') throw new UsageError('No response body — pass --body @file, an inline string, or pipe via stdin.');

  const { kind, message, errors } = validateResponse(operation, ctx.spec, String(status), bodyText);
  // Normalize error objects: expose `message` (documented) alongside the internal `msg`.
  const normalizedErrors = errors.map((e) => ({ path: e.path, message: e.msg }));

  logger.result(
    { endpoint: `${method} ${path}`, status: String(status), valid: kind !== 'fail', kind, message, errors: normalizedErrors },
    () => {
      const icon = kind === 'pass' ? color.green('✓') : kind === 'fail' ? color.red('✗') : color.dim('ℹ');
      logger.out(`${icon} ${message}`);
      for (const e of normalizedErrors) logger.out(`    ${color.dim(e.path)} — ${e.message}`);
    },
  );
  return kind === 'fail' ? 1 : 0;
}
