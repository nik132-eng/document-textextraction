import { Injectable, NotFoundException } from '@nestjs/common';
import { FORM_DEFINITIONS } from './definitions';
import { validateForm, type FormDefinition } from './form-definition';

@Injectable()
export class FormRegistry {
  private readonly byId: Map<string, FormDefinition>;

  constructor() {
    this.byId = FormRegistry.load(FORM_DEFINITIONS);
  }

  /** Validates every definition; throws at boot on the first invalid set (plan 03 §2). */
  static load(defs: FormDefinition[]): Map<string, FormDefinition> {
    const errors = defs.flatMap(validateForm);
    const ids = defs.map((d) => d.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) errors.push(`DEF_ID_DUP ${dup}`);
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
