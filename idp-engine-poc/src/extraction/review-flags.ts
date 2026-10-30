import type { FieldDef, FormDefinition } from '../forms/form-definition';
import type { EngineField } from '../engines/engine.port';

export type ReviewFlag = 'low_confidence' | 'not_found' | 'ungrounded' | 'engine_fallback';

/**
 * Same rules for every engine, so results are comparable:
 * - D8: blank -> null; low confidence -> flag, never a guess.
 * - shared-engine-adapter §6.1: a value with no page/bbox is `ungrounded` (generative engines can
 *   produce plausible text that is not on the page).
 * - §6.3: no confidence at all counts as below threshold.
 */
export function flagsFor(
  def: FieldDef,
  field: EngineField,
  threshold: number,
  warnings: string[] = [],
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const present = field.value !== null;
  if (!present && def.required) flags.push('not_found');
  if (present && (field.confidence === null || field.confidence < threshold))
    flags.push('low_confidence');
  if (present && (field.page === null || field.bbox === null)) flags.push('ungrounded');
  if (present && warnings.includes('engine_fallback')) flags.push('engine_fallback');
  return flags;
}

export function thresholdFor(form: FormDefinition, def: FieldDef, envDefault: number): number {
  return def.minConfidence ?? form.defaults?.minConfidence ?? envDefault;
}
