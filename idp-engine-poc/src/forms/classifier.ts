import { normalizeLabel } from '../common/util';
import { GENERIC_FORM_ID, type FormDefinition } from './form-definition';

export interface Classification {
  formType: string;
  /** hint = caller said so; classifier = cue match; fallback = nothing matched -> GENERIC. */
  source: 'hint' | 'classifier' | 'fallback';
  score: number;
  /** Top candidates, for review and tuning. Never contains document text. */
  scores: { formType: string; score: number }[];
  /** Whether any page text was available (text layer or OCR). */
  hadText: boolean;
}

const DEFAULT_MIN_SCORE = 0.5;

/**
 * Registry cue scoring (plan D2): score = matched cue phrases / total phrases, on normalized text.
 * Pure and deterministic; a new form needs only a cue list, no training job.
 * Whole-document for the POC (packet splitting per page is plan P5).
 */
export function classifyText(text: string, forms: FormDefinition[]): Classification {
  const haystack = ` ${normalizeLabel(text)} `;
  const hadText = haystack.trim().length > 0;
  const scores = forms
    .filter((f) => f.cues && !f.generic)
    .map((f) => {
      const phrases = f.cues!.phrases.map(normalizeLabel).filter(Boolean);
      const hits = phrases.filter((p) => haystack.includes(` ${p} `)).length;
      return {
        formType: f.id,
        score: round(hits / phrases.length),
        min: f.cues!.minScore ?? DEFAULT_MIN_SCORE,
      };
    })
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  const top = scores.slice(0, 3).map(({ formType, score }) => ({ formType, score }));
  if (best && best.score >= best.min && best.score > 0) {
    return {
      formType: best.formType,
      source: 'classifier',
      score: best.score,
      scores: top,
      hadText,
    };
  }
  return {
    formType: GENERIC_FORM_ID,
    source: 'fallback',
    score: best?.score ?? 0,
    scores: top,
    hadText,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
