import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  makeBookingSheetDocx,
  makeBookingSheetPdf,
  makeCms1500Pdf,
  makeIntakePdf,
  makeLetterPdf,
  makeSyntheticCardPng,
  makeUb04Pdf,
} from './synthetic-docs';

/** `pnpm samples` -> ./samples/*.synthetic.* for curl / Swagger / engine bake-offs. */
async function main(): Promise<void> {
  const dir = join(process.cwd(), 'samples');
  await mkdir(dir, { recursive: true });
  const files: Record<string, Buffer> = {
    'cms1500.synthetic.pdf': makeCms1500Pdf(),
    'ub04.synthetic.pdf': makeUb04Pdf(),
    'booking-sheet.synthetic.pdf': makeBookingSheetPdf(),
    'booking-sheet.synthetic.docx': makeBookingSheetDocx(),
    'patient-intake.synthetic.pdf': makeIntakePdf(),
    'letter.synthetic.pdf': makeLetterPdf(),
    'insurance-card.synthetic.png': await makeSyntheticCardPng(),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  process.stdout.write(`wrote ${Object.keys(files).length} synthetic samples to ${dir}\n`);
}

void main();
