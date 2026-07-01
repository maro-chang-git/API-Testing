// `coverage` — evaluate test coverage across a swagger's endpoints. For each
// endpoint it derives the matched cases (the same set generate produces) and
// reports which categories are present, whether auth tests exist, and flags gaps
// (endpoints with no cases, or missing auth tests despite requiring auth).

import { selectEndpoints } from '../lib/endpoint-select.js';
import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';
import { CATEGORY_ORDER, CATEGORY_LABEL } from '../../scripts/core/case-order.js';
import { color } from '../runtime/logger.js';

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  // Coverage is swagger-wide by default; --endpoint / --tag narrow it.
  const target = args.endpoint || args.tag ? args : { ...args, all: true };
  const endpoints = selectEndpoints(ctx, target);

  logger.banner(`coverage — ${ctx.entry.id}  (${endpoints.length} endpoint(s))`);

  const rows = [];
  const totalsByCat = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  const gaps = { endpointsWithNoCases: [], endpointsMissingAuth: [] };

  for (const { method, path, operation } of endpoints) {
    const { profile, cases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, ctx.templates);
    const byCat = {};
    for (const cat of CATEGORY_ORDER) {
      const n = cases.filter((c) => c.category === cat).length;
      byCat[cat] = n;
      totalsByCat[cat] += n;
    }
    const missingCategories = CATEGORY_ORDER.filter((c) => byCat[c] === 0);
    const hasAuthTests = byCat.auth > 0;

    if (cases.length === 0) gaps.endpointsWithNoCases.push(`${method} ${path}`);
    if (profile.auth_required && !hasAuthTests) gaps.endpointsMissingAuth.push(`${method} ${path}`);

    rows.push({
      endpoint: `${method} ${path}`,
      authRequired: profile.auth_required,
      total: cases.length,
      byCategory: byCat,
      missingCategories,
      hasAuthTests,
    });
  }

  const totalCases = rows.reduce((n, r) => n + r.total, 0);
  const result = {
    swagger: ctx.entry.id,
    endpointCount: rows.length,
    totalCases,
    categoriesTracked: CATEGORY_ORDER,
    totalsByCategory: totalsByCat,
    gaps,
    endpoints: rows,
  };

  logger.result(result, () => {
    logger.rule();
    logger.out(color.bold(`Coverage — ${ctx.entry.id}`) + `  ${logger.elapsed()}`);
    logger.out(`  ${rows.length} endpoint(s), ${totalCases} case(s)`);
    logger.out(`  ${color.dim('by category:')} ${CATEGORY_ORDER.map((c) => `${CATEGORY_LABEL[c] || c}:${totalsByCat[c]}`).join('  ')}`);
    logger.out('');
    for (const r of rows) {
      const flag = r.total === 0 ? color.red(' ⚠ no cases')
        : (r.authRequired && !r.hasAuthTests) ? color.yellow(' ⚠ no auth tests') : '';
      const cats = CATEGORY_ORDER.filter((c) => r.byCategory[c]).map((c) => `${c}:${r.byCategory[c]}`).join(' ');
      logger.out(`  ${color.cyan(r.endpoint.padEnd(40))} ${String(r.total).padStart(3)}  ${color.dim(cats)}${flag}`);
    }
    if (gaps.endpointsWithNoCases.length || gaps.endpointsMissingAuth.length) {
      logger.out('');
      logger.out(color.bold('Gaps:'));
      if (gaps.endpointsWithNoCases.length) logger.out(`  ${color.red('no cases:')} ${gaps.endpointsWithNoCases.join(', ')}`);
      if (gaps.endpointsMissingAuth.length) logger.out(`  ${color.yellow('missing auth tests:')} ${gaps.endpointsMissingAuth.join(', ')}`);
    }
  });
  return 0;
}
