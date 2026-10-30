import type { FieldDef, FormDefinition, PathRef } from '../forms/form-definition';
import type { EngineField } from '../engines/engine.port';

export type ReviewFlag =
  | 'low_confidence'
  | 'not_found'
  | 'ungrounded'
  | 'engine_fallback'
  | 'unmapped';

/**
 * Same rules for every engine, so results are comparable:
 * - D8: blank -> null; low confidence -> flag, never a guess.
 * - shared-engine-adapter §6.1: a value with no page/bbox is `ungrounded`.
 * - §6.3: no confidence at all counts as below threshold.
 * - otherFields carry `unmapped`: real values, but not tied to a canonical key, so a human decides.
 * - required group columns are checked per extracted row.
 */
export function flagsFor(
  def: FieldDef | null,
  field: EngineField,
  threshold: number,
  warnings: string[] = [],
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const present = field.value !== null;
  if (!present && def?.required) flags.push('not_found');
  if (present && (field.confidence === null || field.confidence < threshold))
    flags.push('low_confidence');
  if (present && (field.page === null || field.bbox === null)) flags.push('ungrounded');
  if (present && warnings.includes('engine_fallback')) flags.push('engine_fallback');
  if (def === null && present) flags.push('unmapped');
  return flags;
}

export function thresholdFor(
  form: FormDefinition,
  ref: PathRef | null,
  envDefault: number,
): number {
  const def = ref?.kind === 'field' ? ref.def : ref?.kind === 'group' ? ref.column : undefined;
  return def?.minConfidence ?? form.defaults?.minConfidence ?? envDefault;
}
