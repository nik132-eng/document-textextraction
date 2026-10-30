import type { FormDefinition } from '../form-definition';
import { BOOKING_SHEET } from './booking-sheet.form';
import { CMS1500 } from './cms1500.form';
import { GENERIC, INSURANCE_CARD, PATIENT_INTAKE } from './simple.forms';
import { UB04 } from './ub04.form';

export { BOOKING_SHEET, CMS1500, GENERIC, INSURANCE_CARD, PATIENT_INTAKE, UB04 };

/** Built-in forms. More can be added as JSON files in FORMS_DIR without code changes. */
export const FORM_DEFINITIONS: FormDefinition[] = [
  CMS1500,
  UB04,
  BOOKING_SHEET,
  INSURANCE_CARD,
  PATIENT_INTAKE,
  GENERIC,
];
