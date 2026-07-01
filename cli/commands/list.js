// `list` — discovery. Without --swagger: list the available swaggers. With
// --swagger: list that spec's tags and endpoints (filtered by --tag if given).

import { getTagsFromSpec, getEndpointsByTag } from '../../scripts/core/swagger-loader.js';
import { getOperation } from '../../scripts/core/template-matcher.js';
import { color } from '../runtime/logger.js';

export async function run(ctx, args, logger) {
  // No swagger context requested → list the manifest.
  // --json: emit the array directly (documented shape) rather than wrapping in {swaggers:[]}.
  if (!args.swagger && !args.tag && !args.endpoint) {
    logger.banner('list — available swaggers');
    const swaggers = ctx.manifest.map(({ id, file, title }) => ({ id, file, title }));
    logger.result(swaggers, () => {
      logger.rule();
      logger.out(color.bold(`Swaggers (${swaggers.length}):`));
      for (const s of swaggers) logger.out(`  ${color.cyan(s.id.padEnd(14))} ${s.title}`);
      logger.out('');
      logger.out(color.dim('Use `list --swagger <id>` to see its tags and endpoints.'));
    });
    return 0;
  }

  await ctx.useSwagger(args.swagger);
  logger.banner(`list — ${ctx.entry.id}${args.tag ? `  tag:"${args.tag}"` : ''}`);
  const tags = getTagsFromSpec(ctx.spec);
  // Include tags and summary per endpoint entry (documented shape).
  const endpoints = getEndpointsByTag(ctx.spec, args.tag || null)
    .flatMap(({ path, methods }) => methods.map((m) => {
      const op = getOperation(ctx.spec, path, m) || {};
      return {
        method: m,
        path,
        tags: op.tags || [],
        summary: op.summary || '',
        endpoint: `${m} ${path}`,
      };
    }));

  logger.result(
    { swagger: ctx.entry.id, title: ctx.entry.title, tags, endpointCount: endpoints.length, endpoints },
    () => {
      logger.rule();
      logger.out(color.bold(`${ctx.entry.id} — ${ctx.entry.title}`));
      logger.out(`${color.dim('Tags:')} ${tags.join(', ') || '(none)'}`);
      logger.out('');
      logger.out(color.bold(`Endpoints (${endpoints.length})${args.tag ? ` for tag "${args.tag}"` : ''}:`));
      for (const e of endpoints) logger.out(`  ${e.endpoint}${e.summary ? color.dim(`  — ${e.summary}`) : ''}`);
    },
  );
  return 0;
}
