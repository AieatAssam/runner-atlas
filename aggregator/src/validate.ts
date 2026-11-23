// Ajv2020 strict validators for the raw sample and the eight rollup contracts (SPEC 4.1).
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));

export const ROLLUP_FILES = ['manifest', 'fleet', 'benchmarks', 'drift', 'neighbours', 'rollouts', 'seasonality', 'regions'] as const;
export type RollupFile = (typeof ROLLUP_FILES)[number];

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });

function load(path: string): unknown {
  return JSON.parse(readFileSync(SCHEMA_DIR + path, 'utf8'));
}

const compiled = {
  sample: ajv.compile(load('raw-sample.schema.json') as object),
} as { sample: ValidateFunction };

const rollupValidators = {} as Record<RollupFile, ValidateFunction>;
for (const name of ROLLUP_FILES) {
  rollupValidators[name] = ajv.compile(load(`rollups/${name}.schema.json`) as object);
}

export const validateSampleSchema: ValidateFunction = compiled.sample;

export function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown schema error';
  return errors
    .slice(0, 3)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ');
}

// Returns null when valid, otherwise a short reason string.
export function sampleSchemaError(value: unknown): string | null {
  if (validateSampleSchema(value)) return null;
  return formatErrors(validateSampleSchema.errors);
}

// Returns null when valid, otherwise a short reason string.
export function rollupSchemaError(name: RollupFile, value: unknown): string | null {
  const v = rollupValidators[name];
  if (v(value)) return null;
  return formatErrors(v.errors);
}
