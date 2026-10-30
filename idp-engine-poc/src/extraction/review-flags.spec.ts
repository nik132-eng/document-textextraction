import { describe, expect, it } from 'vitest';
import type { EngineField } from '../engines/engine.port';
import type { FieldDef } from '../forms/form-definition';
import { flagsFor } from './review-flags';

const def: FieldDef = { path: 'member.id', label: 'Member ID', type: 'code', required: true };
const field = (over: Partial<EngineField>): EngineField => ({
  path: 'member.id',
  value: 'ZZX1',
  confidence: 95,
  confidenceSource: 'numeric',
  page: 1,
  bbox: { left: 0, top: 0, width: 0.1, height: 0.1 },
  ...over,
});

describe('flagsFor (same rules for every engine)', () => {
  it('confident, grounded value -> no flags', () => {
    expect(flagsFor(def, field({}), 80)).toEqual([]);
  });
  it('below threshold -> low_confidence', () => {
    expect(flagsFor(def, field({ confidence: 79 }), 80)).toEqual(['low_confidence']);
  });
  it('no confidence at all counts as low (shared §6.3)', () => {
    expect(flagsFor(def, field({ confidence: null, confidenceSource: 'none' }), 80)).toEqual([
      'low_confidence',
    ]);
  });
  it('value without page/bbox -> ungrounded (shared §6.1)', () => {
    expect(flagsFor(def, field({ bbox: null }), 80)).toEqual(['ungrounded']);
  });
  it('required + blank -> not_found; optional + blank -> nothing', () => {
    expect(flagsFor(def, field({ value: null, confidence: null }), 80)).toEqual(['not_found']);
    expect(
      flagsFor({ ...def, required: false }, field({ value: null, confidence: null }), 80),
    ).toEqual([]);
  });
  it('fallback model -> engine_fallback on every present value', () => {
    expect(flagsFor(def, field({}), 80, ['engine_fallback'])).toEqual(['engine_fallback']);
  });
});
