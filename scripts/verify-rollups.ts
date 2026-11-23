// Validates every rollup file against schemas/rollups/*.schema.json, plus the manifest checksums (SPEC 8, schema row).
//   node scripts/verify-rollups.ts            checks data/rollups
//   RUNNER_ATLAS_ROLLUPS_DIR=<dir> node scripts/verify-rollups.ts
// The work is done by the aggregator's `validate` command, so the publish step and this script cannot disagree.
import { resolve } from 'node:path';
import { main } from '../aggregator/src/cli.ts';

const dir = resolve(process.env.RUNNER_ATLAS_ROLLUPS_DIR || 'data/rollups');
main(['validate', '--dir', dir]);
if (process.exitCode) {
  console.error(`verify-rollups: ${dir} failed`);
} else {
  console.log('verify-rollups: ok');
}
