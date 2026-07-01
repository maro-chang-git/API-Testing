// `generate` — produce test cases for the target endpoint(s). Always writes the
// JSON test-case file (same shape as the browser's Export JSON); --postman and/or
// --karate additionally run the existing exporters. Files land under output/{id}/
// via the same save path the browser uses (the fetch shim writes them to disk).

import { selectEndpoints } from '../lib/endpoint-select.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { CATEGORY_ORDER } from '../../scripts/core/case-order.js';
import { filenameSlug } from '../../scripts/exporters/export-shared.js';
import { exportPostman } from '../../scripts/exporters/postman-collection-builder.js';
import { exportKarate } from '../../scripts/exporters/karate-feature-builder.js';
import { writeTestcases } from '../lib/testcase-file.js';
import { UsageError } from '../lib/errors.js';
import { color } from '../runtime/logger.js';

// Which output formats to produce. --format "a,b" is explicit; otherwise JSON is
// always produced and --postman / --karate add those.
const VALID_FORMATS = new Set(['json', 'postman', 'karate']);

function resolveFormats(args) {
  if (args.format) {
    const tokens = args.format.split(',').map((s) => s.trim().toLowerCase());
    const unknown = tokens.filter((t) => !VALID_FORMATS.has(t));
    if (unknown.length) throw new UsageError(`Unknown --format value(s): ${unknown.join(', ')}. Valid: json, postman, karate.`);
    const set = new Set(tokens);
    return { json: set.has('json'), postman: set.has('postman'), karate: set.has('karate') };
  }
  return { json: true, postman: !!args.postman, karate: !!args.karate };
}

function countByCategory(cases) {
  const counts = {};
  for (const cat of CATEGORY_ORDER) {
    const n = cases.filter((c) => c.category === cat).length;
    if (n) counts[cat] = n;
  }
  return counts;
}

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);
  const formats = resolveFormats(args);
  const id = ctx.entry.id;
  const formatList = Object.keys(formats).filter((k) => formats[k]);

  logger.banner(`generate — ${id}  [${formatList.join(', ')}]`);
  logger.debug(`${targets.length} endpoint(s) selected`);

  const endpoints = [];
  for (let i = 0; i < targets.length; i++) {
    const { method, path, operation } = targets[i];
    logger.step(`[${i + 1}/${targets.length}] ${method} ${path}`);

    const { profile, cases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, ctx.templates);
    const slug = filenameSlug(profile.path);
    const files = [];

    if (formats.json) {
      files.push(await writeTestcases(ctx, profile, cases));
    }
    if (formats.postman) {
      await exportPostman(profile, operation, ctx.spec, cases, id);
      files.push(`output/${id}/postman/postman-${profile.method.toLowerCase()}-${slug}.json`);
    }
    if (formats.karate) {
      await exportKarate(profile, operation, ctx.spec, cases, id);
      files.push(`output/${id}/karate/karate-${profile.method.toLowerCase()}-${slug}.feature`);
    }

    endpoints.push({
      endpoint: `${method} ${path}`,
      total: cases.length,
      byCategory: countByCategory(cases),
      files,
    });
    logger.info(`${method} ${path} → ${cases.length} cases`);
  }

  const grandTotal = endpoints.reduce((n, e) => n + e.total, 0);
  logger.result(
    { swagger: id, formats: formatList, endpointCount: endpoints.length, totalCases: grandTotal, endpoints },
    () => {
      logger.rule();
      logger.out(color.bold(`Generated ${grandTotal} test case(s) across ${endpoints.length} endpoint(s) [${id}]`) + `  ${logger.elapsed()}`);
      for (const e of endpoints) {
        const cats = Object.entries(e.byCategory).map(([c, n]) => `${c}:${n}`).join('  ');
        logger.out(`  ${color.cyan(e.endpoint)}  (${e.total})  ${color.dim(cats)}`);
        for (const f of e.files) logger.out(`      ${color.green('→')} ${f}`);
      }
      const first = targets[0];
      const endpointFlag = targets.length === 1 ? `--endpoint "${first.method} ${first.path}"` : '--all';
      logger.nextSteps([
        `node cli/index.js request --swagger ${id} ${endpointFlag} --token "$TOKEN"`,
        targets.length === 1
          ? `node cli/index.js explore --swagger ${id} ${endpointFlag} --token "$TOKEN" --save`
          : null,
        `node cli/index.js coverage --swagger ${id}`,
      ].filter(Boolean));
    },
  );
  return 0;
}
