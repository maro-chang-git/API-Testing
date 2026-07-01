// `explore` — exploratory testing. Take a response (live by default, or a pasted
// sample via --body/--status), derive data-driven assertions from its JSON shape,
// and fold them into the matching template cases — exactly the browser's
// "generate from response" flow. With --save, re-export the testcases JSON with
// the folded assertions attached.

import { selectEndpoints } from '../lib/endpoint-select.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { generateTestCasesFromResponse } from '../../scripts/generate/response-test-generator.js';
import { foldGeneratedCases } from '../../scripts/generate/case-folder.js';
import { runLive } from '../lib/live-runner.js';
import { writeTestcases } from '../lib/testcase-file.js';
import { readBodyArg, parseHeaderFlags } from '../lib/read-input.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);
  if (targets.length > 1) throw new UsageError('`explore` runs one endpoint — narrow with --endpoint "<METHOD> <path>".');
  const { method, path, operation } = targets[0];
  const { profile, cases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, ctx.templates);

  logger.banner(`explore — ${ctx.entry.id}  ${method} ${path}`);

  // Source the response: a pasted sample (offline) wins; otherwise fire it live.
  let status, body, source;
  if (args.body != null) {
    logger.step('loading sample body…');
    body = await readBodyArg(args.body, ctx.projectRoot);
    status = parseInt(args.status || '200', 10);
    source = 'sample';
  } else {
    logger.step('sending live request…');
    const overrides = {
      baseUrl: args['base-url'],
      token: args.token,
      headers: Object.entries(parseHeaderFlags(args.header || [])).map(([key, val]) => ({ key, val })),
    };
    const live = await runLive(ctx, { method, path, operation, profile, overrides });
    if (!live.ok) throw new Error(`Live request failed: ${live.error}. Provide a sample with --body instead.`);
    if (live.stream) throw new UsageError('Response is a stream (no JSON body) — data-driven generation is not applicable.');
    status = live.response.status;
    body = live.response.body;
    source = 'live';
    logger.info(`${live.response.status} ${live.response.statusText}  ${color.dim(`${live.response.elapsed}ms`)}`);
  }

  logger.step('deriving assertions…');
  const generated = generateTestCasesFromResponse({ status, body, profile });
  if (!generated.length) {
    logger.result(
      { endpoint: `${method} ${path}`, source, status, attached: 0, orphanCount: 0, note: 'No assertions derived (response body is not JSON or had no usable shape).' },
      () => logger.out(color.dim('No assertions could be derived (response body is not JSON).')),
    );
    return 0;
  }

  logger.step('folding into cases…');
  const folded = foldGeneratedCases(cases, generated);
  const enriched = folded.matchedCases.filter((c) => c.generatedAssertions?.length)
    .map((c) => ({ id: c.id, assertions: c.generatedAssertions.length }));

  let savedFile = null;
  if (args.save) {
    savedFile = await writeTestcases(ctx, profile, folded.matchedCases);
  }

  logger.result(
    { endpoint: `${method} ${path}`, source, status, attached: folded.attached, orphanCount: folded.orphanCount, enrichedCases: enriched, savedFile },
    () => {
      logger.rule();
      logger.out(color.bold(`Explored ${method} ${path}`) + `  ${color.dim(`${source}, status ${status}`)}  ${logger.elapsed()}`);
      logger.out(`  attached ${color.green(folded.attached)} assertion(s) to matching case(s); ${folded.orphanCount} standalone`);
      for (const e of enriched) logger.out(`  ${color.cyan(e.id)} +${e.assertions} assertion(s)`);
      if (savedFile) logger.out(`  ${color.green('→')} ${savedFile}`);
      else logger.out(color.dim('  (use --save to write the updated testcases JSON)'));
    },
  );
  return 0;
}
