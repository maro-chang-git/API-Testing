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
import { maybePromoteAuth, isAuthEnforced } from '../lib/auth-promote.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

async function exploreOne(ctx, { method, path, operation }, args, logger) {
  const { profile, cases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, ctx.templates);

  // Source the response: a pasted sample (offline) wins; otherwise fire it live.
  let status, body, source;
  if (args.body != null) {
    body = await readBodyArg(args.body, ctx.projectRoot);
    status = parseInt(args.status || '200', 10);
    source = 'sample';
  } else {
    const overrides = {
      baseUrl: args['base-url'],
      token: args.token,
      headers: Object.entries(parseHeaderFlags(args.header || [])).map(([key, val]) => ({ key, val })),
    };
    const live = await runLive(ctx, { method, path, operation, profile, overrides });
    if (!live.ok) {
      logger.warn(`${method} ${path} — live request failed: ${live.error}`);
      return { endpoint: `${method} ${path}`, source: 'live', status: null, attached: 0, orphanCount: 0, savedFile: null, error: live.error };
    }
    if (live.stream) {
      logger.warn(`${method} ${path} — response is a stream (no JSON body); skipping.`);
      return { endpoint: `${method} ${path}`, source: 'live', status: null, attached: 0, orphanCount: 0, savedFile: null, note: 'stream' };
    }
    status = live.response.status;
    body = live.response.body;
    source = 'live';
    logger.info(`${method} ${path}  ${live.response.status} ${live.response.statusText}  ${color.dim(`${live.response.elapsed}ms`)}`);

    // A 401/403 on a non-auth-required endpoint → promote and stop; don't fold
    // assertions from an error body into the happy-path template case.
    if (isAuthEnforced(status) && !profile.auth_required) {
      const promotion = await maybePromoteAuth(ctx, method, path, operation, profile, status, ctx.templates);
      const note = `${status} response — promoted to auth-required; added ${promotion.addedAuthCases} auth test case(s). Specs saved.`;
      logger.warn(`${method} ${path} — ${note}`);
      return { endpoint: `${method} ${path}`, source, status, attached: 0, orphanCount: 0, savedFile: null, authPromoted: true, addedAuthCases: promotion.addedAuthCases, note };
    }

    // Non-2xx (not auth-enforced) — skip derivation; deriving from error bodies
    // would fold wrong-shape assertions into the happy-path case.
    if (status < 200 || status >= 300) {
      const note = `${status} response — skipping assertion derivation (not a success response).`;
      logger.warn(`${method} ${path} — ${note}`);
      return { endpoint: `${method} ${path}`, source, status, attached: 0, orphanCount: 0, savedFile: null, note };
    }
  }

  const generated = generateTestCasesFromResponse({ status, body, profile });
  if (!generated.length) {
    return { endpoint: `${method} ${path}`, source, status, attached: 0, orphanCount: 0, savedFile: null, note: 'No assertions derived (response body is not JSON or had no usable shape).' };
  }

  const folded = foldGeneratedCases(cases, generated);
  const enriched = folded.matchedCases.filter((c) => c.generatedAssertions?.length)
    .map((c) => ({ id: c.id, assertions: c.generatedAssertions.length }));

  let savedFile = null;
  if (args.save) {
    savedFile = await writeTestcases(ctx, profile, folded.matchedCases);
  }

  return { endpoint: `${method} ${path}`, source, status, attached: folded.attached, orphanCount: folded.orphanCount, enrichedCases: enriched, savedFile };
}

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);

  // Single-endpoint fast path keeps the existing UX (banner + inline output).
  if (targets.length === 1) {
    const { method, path, operation } = targets[0];
    logger.banner(`explore — ${ctx.entry.id}  ${method} ${path}`);
    if (args.body != null) logger.step('loading sample body…');
    else logger.step('sending live request…');

    const r = await exploreOne(ctx, { method, path, operation }, args, logger);
    if (r.error) throw new Error(`Live request failed: ${r.error}. Provide a sample with --body instead.`);
    if (r.note === 'stream') throw new UsageError('Response is a stream (no JSON body) — data-driven generation is not applicable.');

    // Documented schema aliases for agent consumption.
    const jsonOut = { ...r, folded: r.attached, saved: !!r.savedFile };

    logger.result(jsonOut, () => {
      logger.rule();
      logger.out(color.bold(`Explored ${method} ${path}`) + `  ${color.dim(`${r.source}, status ${r.status}`)}  ${logger.elapsed()}`);
      if (r.note) { logger.out(color.dim(`  ${r.note}`)); return; }
      logger.out(`  attached ${color.green(r.attached)} assertion(s) to matching case(s); ${r.orphanCount} standalone`);
      for (const e of r.enrichedCases || []) logger.out(`  ${color.cyan(e.id)} +${e.assertions} assertion(s)`);
      if (r.savedFile) logger.out(`  ${color.green('→')} ${r.savedFile}`);
      else logger.out(color.dim('  (use --save to write the updated testcases JSON)'));
    });
    return 0;
  }

  // Multi-endpoint (--all / --tag): loop and aggregate.
  if (args.body != null) throw new UsageError('--body is not supported with --all / --tag (pass --body only for a single --endpoint).');
  logger.banner(`explore — ${ctx.entry.id}  (${targets.length} endpoint(s))`);

  const results = [];
  let totalAttached = 0;
  for (let i = 0; i < targets.length; i++) {
    const { method, path, operation } = targets[i];
    logger.step(`[${i + 1}/${targets.length}] ${method} ${path}`);
    const r = await exploreOne(ctx, { method, path, operation }, args, logger);
    results.push(r);
    totalAttached += r.attached || 0;
  }

  logger.result(
    { swagger: ctx.entry.id, endpointCount: targets.length, totalAttached, endpoints: results },
    () => {
      logger.rule();
      logger.out(color.bold(`Explored ${targets.length} endpoint(s) — ${totalAttached} assertion(s) attached`) + `  ${logger.elapsed()}`);
      for (const r of results) {
        const suffix = r.error ? color.red(` ✖ ${r.error}`)
          : r.note ? color.dim(` — ${r.note}`)
          : `  ${color.green('+' + r.attached)}`;
        logger.out(`  ${color.cyan(r.endpoint)}${suffix}`);
        if (r.savedFile) logger.out(`      ${color.green('→')} ${r.savedFile}`);
      }
      if (!args.save) logger.out(color.dim('\n  (use --save to write updated testcases JSON)'));
    },
  );
  return 0;
}
