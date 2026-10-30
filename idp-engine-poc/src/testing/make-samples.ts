import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSyntheticCardPng, makeSyntheticPdf } from './synthetic-docs';

/** `pnpm samples` -> ./samples/*.synthetic.{png,pdf} for curl / Swagger / engine bake-offs. */
async function main(): Promise<void> {
  const dir = join(process.cwd(), 'samples');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'insurance-card.synthetic.png'), await makeSyntheticCardPng());
  await writeFile(join(dir, 'patient-intake.synthetic.pdf'), makeSyntheticPdf());
  process.stdout.write(`wrote synthetic samples to ${dir}\n`);
}

void main();
