// Shared writer for the per-endpoint testcases JSON (output/{id}/api-…-testcases.json),
// used by both `generate` and `explore --save`. Matches the browser's Export JSON
// shape and preserves any saved run results across regenerations (the browser
// re-embeds them from localStorage; here we read them back off the prior file).

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { compareTestCases } from '../../scripts/core/case-order.js';
import { filenameSlug } from '../../scripts/exporters/export-shared.js';

export function testcasesRelPath(swaggerId, profile) {
  return `output/${swaggerId}/api-${profile.method.toLowerCase()}-${filenameSlug(profile.path)}-testcases.json`;
}

// Read a prior testcases file's saved results → { tcId: result }. Empty when absent.
export async function loadPriorResults(projectRoot, relPath) {
  try {
    const prior = JSON.parse(await readFile(path.join(projectRoot, relPath), 'utf8'));
    const map = {};
    for (const tc of prior.testcases ?? []) if (tc.result) map[tc.id] = tc.result;
    return map;
  } catch {
    return {};
  }
}

// Write the testcases file for an endpoint, re-embedding any prior run results.
// Returns the repo-relative path written.
export async function writeTestcases(ctx, profile, cases) {
  const rel = testcasesRelPath(ctx.entry.id, profile);
  const priorResults = await loadPriorResults(ctx.projectRoot, rel);
  const sorted = cases.slice().sort(compareTestCases);
  const payload = {
    generated_at: new Date().toISOString(),
    swagger_endpoint: {
      method: profile.method, path: profile.path, summary: profile.summary, auth_type: profile.auth_type,
    },
    testcases: sorted.map((tc) => (priorResults[tc.id] ? { ...tc, result: priorResults[tc.id] } : tc)),
  };
  const filename = rel.split('/').pop();
  await ctx.specsStore.saveOrDownload(rel, filename, JSON.stringify(payload, null, 2), 'application/json');
  return rel;
}
