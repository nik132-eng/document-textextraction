import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { FORM_DEFINITIONS } from './definitions';
import {
  formDefinitionSchema,
  GENERIC_FORM_ID,
  validateForm,
  type FormDefinition,
} from './form-definition';

/**
 * Built-in forms + every *.json in FORMS_DIR. All are validated at boot; one bad definition
 * stops the app (plan 03 §2), so a broken form never reaches production silently.
 * A JSON form with the same id as a built-in one replaces it (per-hospital layouts).
 */
@Injectable()
export class FormRegistry {
  private readonly logger = new Logger(FormRegistry.name);
  private readonly byId: Map<string, FormDefinition>;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    const extra = cfg.formsDir ? FormRegistry.readDir(cfg.formsDir) : [];
    const builtIn = FORM_DEFINITIONS.filter((d) => !extra.some((e) => e.id === d.id));
    this.byId = FormRegistry.load([...builtIn, ...extra]);
    if (extra.length) this.logger.log({ msg: 'forms.loaded_from_dir', count: extra.length });
  }

  static readDir(dir: string): FormDefinition[] {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const errors: string[] = [];
    const defs: FormDefinition[] = [];
    for (const file of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        errors.push(`${file}: DEF_JSON not valid JSON`);
        continue;
      }
      const errs = validateForm(raw);
      if (errs.length) errors.push(...errs.map((e) => `${file}: ${e}`));
      else defs.push(formDefinitionSchema.parse(raw));
    }
    if (errors.length) throw new Error(`Invalid form files in FORMS_DIR:\n${errors.join('\n')}`);
    return defs;
  }

  static load(defs: FormDefinition[]): Map<string, FormDefinition> {
    const errors = defs.flatMap(validateForm);
    const ids = defs.map((d) => d.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) errors.push(`DEF_ID_DUP ${dup}`);
    if (!ids.includes(GENERIC_FORM_ID)) errors.push('DEF_NO_GENERIC the GENERIC form is required');
    if (errors.length) throw new Error(`Invalid form definitions:\n${errors.join('\n')}`);
    return new Map(defs.map((d) => [d.id, d]));
  }

  get(id: string): FormDefinition {
    const def = this.byId.get(id);
    if (!def)
      throw new NotFoundException({ code: 'FORM_UNKNOWN', message: `Unknown formType ${id}` });
    return def;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): FormDefinition[] {
    return [...this.byId.values()];
  }
}
