// `body` — print a realistic example request body for an endpoint (the specs
// request body if set, else built from the operation's request schema). The AI
// can pipe this into `request --body -` after tweaking it.

import { selectEndpoints } from '../lib/endpoint-select.js';
import { color } from '../runtime/logger.js';

export async function run(ctx, args, logger) {
  await ctx.useSwagger(args.swagger);
  const targets = selectEndpoints(ctx, args);
  if (targets.length > 1) {
    logger.warn('Multiple endpoints matched — showing the first. Narrow with --endpoint for one.');
  }
  const { method, path, operation } = targets[0];
  logger.banner(`body — ${ctx.entry.id}  ${method} ${path}`);
  const body = ctx.specsStore.effectiveRequestBody(method, path, operation, ctx.spec);

  if (body === null || body === undefined) {
    logger.result(
      { endpoint: `${method} ${path}`, body: null, note: 'No request body for this method/endpoint.' },
      () => logger.out(color.dim(`No request body for ${method} ${path}.`)),
    );
    return 0;
  }

  // Derive the content type from the operation's request body media type (if any).
  const reqBody = operation.requestBody || operation.parameters?.find((p) => p.in === 'body');
  const contentType = (reqBody?.content ? Object.keys(reqBody.content)[0] : null) || 'application/json';

  // Primary output is the JSON body itself (pipeable), in both modes.
  logger.result(
    { endpoint: `${method} ${path}`, contentType, body },
    () => logger.out(JSON.stringify(body, null, 2)),
  );
  return 0;
}
