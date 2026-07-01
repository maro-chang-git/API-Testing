// `request` — fire a live HTTP request for an endpoint, optionally driving a
// specific test case (--case TC-…, which applies its auth preset and checks the
// response against the case's expected status). Prints status, timing, headers,
// body, SSE reconstruction and schema validation.
//
// Exit code: 0 = ok (and case passed, if one was run); 1 = case failed;
// 2 = the request could not be made (network/URL error).

import { selectEndpoints } from '../lib/endpoint-select.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { runLive } from '../lib/live-runner.js';
import { readBodyArg, parseHeaderFlags } from '../lib/read-input.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

const statusColor = (s) => (s >= 500 ? color.red : s >= 400 ? color.yellow : color.green);

function truncate(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);
  if (targets.length > 1) throw new UsageError('`request` runs one endpoint — narrow with --endpoint "<METHOD> <path>".');
  const { method, path, operation } = targets[0];

  const { profile, cases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, ctx.templates);

  let tc = null;
  if (args.case) {
    tc = cases.find((c) => c.id === args.case);
    if (!tc) throw new UsageError(`Test case "${args.case}" not found for ${method} ${path}. Available: ${cases.map((c) => c.id).join(', ')}`);
  }

  const overrides = {
    baseUrl: args['base-url'],
    token: args.token,
    body: args.body != null ? await readBodyArg(args.body, ctx.projectRoot) : undefined,
    headers: Object.entries(parseHeaderFlags(args.header || [])).map(([key, val]) => ({ key, val })),
  };

  logger.banner(`request — ${ctx.entry.id}  ${method} ${path}${tc ? `  [${tc.id}]` : ''}`);
  logger.step('sending request…');
  const result = await runLive(ctx, { method, path, operation, profile, tc, overrides });

  logger.result(result, () => {
    const r = result;
    logger.out(`${color.bold(r.request.method)} ${r.request.url}`);
    if (!r.ok) { logger.out(color.red(`✖ request failed: ${r.error}`)); return; }
    const sc = statusColor(r.response.status);
    logger.out(`${sc(`${r.response.status} ${r.response.statusText}`)}  ${color.dim(`${r.response.elapsed}ms`)}  ${color.dim(r.response.contentType)}`);
    if (r.testCase) {
      const verdict = r.testCase.passed ? color.green('✓ PASS') : color.red('✗ FAIL');
      logger.out(`${verdict}  expected ${r.testCase.expected.join(' or ')}, got ${r.response.status}`);
    }
    if (r.schema) {
      const icon = r.schema.kind === 'pass' ? color.green('✓') : r.schema.kind === 'fail' ? color.red('✗') : color.dim('ℹ');
      logger.out(`${icon} schema: ${r.schema.message}`);
      for (const e of r.schema.errors) logger.out(`    ${color.dim(e.path)} — ${e.msg}`);
    }
    logger.rule();
    if (r.stream) {
      logger.out(color.bold(`stream: ${r.stream.count} events`));
      if (r.stream.text) logger.out(`  reconstructed: ${truncate(r.stream.text, 500)}`);
    } else {
      logger.out(color.dim('── body ──'));
      logger.out(truncate(r.response.body));
    }
  });

  if (!result.ok) return 2;
  if (result.testCase && !result.testCase.passed) return 1;
  return 0;
}
