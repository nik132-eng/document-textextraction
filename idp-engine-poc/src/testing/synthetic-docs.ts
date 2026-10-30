import sharp from 'sharp';
import { linesToPdf } from '../conversion/text-pdf';
import { writeZip } from './zip-writer';

/**
 * Synthetic documents only (plan 00 §4: no real patient data until BAA + AI opt-out are confirmed).
 * Every value is obviously fake: SAMPLE names, 555 phones, ZZ-prefixed ids, 0000 NPIs.
 * Text-layer PDFs: good for classification, conversion and pipeline tests. For engine accuracy
 * use filled official blank forms (NUCC CMS-1500, NUBC UB-04) with fake data (MANUAL-SETUP §4).
 */
export const SYNTHETIC_CARD_LINES = [
  'SYNTHETIC HEALTH PLAN',
  'PPO Gold (SAMPLE)',
  'Member: JANE Q SAMPLE',
  'Member ID: ZZX123456789',
  'Group: 99999',
  'RxBIN: 000000   RxPCN: SYNTH',
  'Payer ID: 00000',
  'Office visit copay: $25',
  'Customer service: 1-800-555-0199',
];

export const SYNTHETIC_INTAKE_LINES = [
  'PATIENT REGISTRATION (SYNTHETIC SAMPLE)',
  'Last name: SAMPLE        First name: JANE',
  'Date of birth: 01/02/1980     Sex: F',
  'Phone: (555) 010-0100',
  'Street address: 123 EXAMPLE ST',
  'City: SPRINGFIELD   State: ZZ   ZIP code: 00000',
  'Primary insurance: SYNTHETIC HEALTH PLAN',
  'Policy / member ID: ZZX123456789     Group number: 99999',
  'Subscriber is patient:  [X] Self   [ ] Spouse   [ ] Child',
  'Emergency contact: JOHN SAMPLE (555) 010-0101',
];

export const SYNTHETIC_CMS1500_LINES = [
  'HEALTH INSURANCE CLAIM FORM',
  'APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12          (SYNTHETIC SAMPLE)',
  '1. MEDICARE [ ]  MEDICAID [ ]  TRICARE [ ]  CHAMPVA [ ]  GROUP HEALTH PLAN [X]  FECA [ ]  OTHER [ ]',
  "1a. INSURED'S I.D. NUMBER: ZZX123456789",
  "2. PATIENT'S NAME (Last Name, First Name, Middle Initial): SAMPLE, JANE, Q",
  "3. PATIENT'S BIRTH DATE: 01 02 1980      SEX: M [ ]  F [X]",
  "4. INSURED'S NAME (Last Name, First Name, Middle Initial): SAMPLE, JANE, Q",
  "5. PATIENT'S ADDRESS (No., Street): 123 EXAMPLE ST   CITY: SPRINGFIELD   STATE: ZZ   ZIP CODE: 00000   TELEPHONE: (555) 010-0100",
  '6. PATIENT RELATIONSHIP TO INSURED: Self [X]  Spouse [ ]  Child [ ]  Other [ ]',
  "7. INSURED'S ADDRESS (No., Street): 123 EXAMPLE ST",
  "11. INSURED'S POLICY GROUP OR FECA NUMBER: 99999",
  "11a. INSURED'S DATE OF BIRTH: 01 02 1980",
  '11c. INSURANCE PLAN NAME OR PROGRAM NAME: SYNTHETIC PPO',
  '17. NAME OF REFERRING PROVIDER OR OTHER SOURCE: DR JOHN SAMPLE MD    17b. NPI: 0000000001',
  '21. DIAGNOSIS OR NATURE OF ILLNESS OR INJURY   ICD Ind. 0',
  'A. Z00.00   B. E11.9   C. I10   D. ',
  '23. PRIOR AUTHORIZATION NUMBER: ZZAUTH0001',
  '24. A. DATE(S) OF SERVICE From | To | B. PLACE OF SERVICE | C. EMG | D. CPT/HCPCS | MODIFIER | E. DIAGNOSIS POINTER | F. $ CHARGES | G. DAYS OR UNITS | J. RENDERING PROVIDER ID. # NPI',
  '01 05 26 | 01 05 26 | 11 |  | 99213 | 25 | A | 150.00 | 1 | 0000000002',
  '01 05 26 | 01 05 26 | 11 |  | 36415 |  | B | 25.00 | 1 | 0000000002',
  '25. FEDERAL TAX I.D. NUMBER: 00-0000000   SSN [ ] EIN [X]',
  "26. PATIENT'S ACCOUNT NO.: ZZACCT-0001      27. ACCEPT ASSIGNMENT? YES [X] NO [ ]",
  '28. TOTAL CHARGE: $175.00     29. AMOUNT PAID: $0.00',
  '32. SERVICE FACILITY LOCATION INFORMATION: SYNTHETIC CLINIC, 1 TEST WAY, SPRINGFIELD ZZ 00000   32a. NPI 0000000003',
  '33. BILLING PROVIDER INFO & PH #: SYNTHETIC MEDICAL GROUP (555) 010-0199   33a. NPI 0000000004',
];

export const SYNTHETIC_UB04_LINES = [
  'UB-04 UNIFORM BILL (CMS-1450)   NUBC National Uniform Billing Committee   (SYNTHETIC SAMPLE)',
  '1. SYNTHETIC GENERAL HOSPITAL, 1 TEST WAY, SPRINGFIELD ZZ 00000',
  '3a. PAT. CNTL #: ZZPCN-0001     3b. MED. REC. #: ZZMRN-0001     4. TYPE OF BILL: 0111',
  '5. FED. TAX NO.: 00-0000000     6. STATEMENT COVERS PERIOD  FROM: 010526  THROUGH: 010826',
  '8. PATIENT NAME: SAMPLE, JANE Q     9. PATIENT ADDRESS: 123 EXAMPLE ST SPRINGFIELD ZZ 00000',
  '10. BIRTHDATE: 01021980   11. SEX: F   12. ADMISSION DATE: 010526   13. HR: 08   14. TYPE: 1   15. SRC: 1   17. STAT: 01',
  '42. REV. CD. | 43. DESCRIPTION | 44. HCPCS / RATE / HIPPS CODE | 45. SERV. DATE | 46. SERV. UNITS | 47. TOTAL CHARGES | 48. NON-COVERED CHARGES',
  '0110 | ROOM-BOARD/PVT |  | 010526 | 3 | 3000.00 | ',
  '0250 | PHARMACY |  | 010526 | 1 | 120.00 | ',
  '0300 | LABORATORY | 80053 | 010626 | 1 | 85.00 | ',
  '0001 | TOTAL |  |  |  | 3205.00 | ',
  '50. PAYER NAME: SYNTHETIC HEALTH PLAN    51. HEALTH PLAN ID: ZZHP0001    56. NPI: 0000000005',
  "58. INSURED'S NAME: SAMPLE, JANE Q   59. P. REL: 18   60. INSURED'S UNIQUE ID: ZZX123456789",
  '61. GROUP NAME: SYNTHETIC EMPLOYER   62. INSURANCE GROUP NO.: 99999   63. TREATMENT AUTHORIZATION CODES: ZZAUTH0002',
  '66. DX: 0   67. PRINCIPAL DIAGNOSIS: J18.9   67A: E11.9   67B: I10   69. ADMIT DX: R05.9',
  '74. PRINCIPAL PROCEDURE: 5A1955Z   76. ATTENDING NPI: 0000000006  NAME: SAMPLE, JOHN',
];

export const SYNTHETIC_BOOKING_PARAGRAPHS = [
  'SYNTHETIC GENERAL HOSPITAL - SURGERY BOOKING / SCHEDULING REQUEST (SYNTHETIC SAMPLE)',
  'Patient last name: SAMPLE',
  'Patient first name: JANE',
  'Date of birth: 01/02/1980     Sex: F     MRN: ZZMRN-0001',
  'Patient phone: (555) 010-0100',
  'Surgeon: DR JOHN SAMPLE     Surgeon NPI: 0000000007',
  'Facility: SYNTHETIC GENERAL HOSPITAL - MAIN OR',
  'Surgery date: 02/14/2026     Start time: 07:30     Estimated duration: 2 hours',
  'Patient class: Outpatient     Length of stay: 0 days',
  'Anesthesia: General',
  'Diagnosis: Synthetic knee condition     ICD-10: M17.11',
  'Primary insurance: SYNTHETIC HEALTH PLAN     Member ID: ZZX123456789     Group number: 99999',
  'Authorization number: ZZAUTH0003',
  'Allergies: NKDA     Latex allergy: [ ]',
  'Special equipment: Synthetic implant set',
];

export const SYNTHETIC_BOOKING_PROCEDURES = [
  ['CPT', 'Procedure', 'Side', 'Modifier'],
  ['27447', 'Total knee arthroplasty (synthetic)', 'Right', 'RT'],
  ['20610', 'Joint injection (synthetic)', 'Left', 'LT'],
];

export const SYNTHETIC_LETTER_LINES = [
  'Dear Sample Recipient,',
  'This is a synthetic letter with no known form layout.',
  'Reference number: ZZREF-0001',
  'Account: ZZACCT-0002',
  'Regards, Synthetic Sender',
];

export const makeSyntheticPdf = (lines: string[]): Buffer => linesToPdf(lines);
export const makeCms1500Pdf = (): Buffer => linesToPdf(SYNTHETIC_CMS1500_LINES);
export const makeUb04Pdf = (): Buffer => linesToPdf(SYNTHETIC_UB04_LINES);
export const makeIntakePdf = (): Buffer => linesToPdf(SYNTHETIC_INTAKE_LINES);
export const makeLetterPdf = (): Buffer => linesToPdf(SYNTHETIC_LETTER_LINES);
export const makeBookingSheetPdf = (): Buffer =>
  linesToPdf([
    ...SYNTHETIC_BOOKING_PARAGRAPHS,
    '',
    ...SYNTHETIC_BOOKING_PROCEDURES.map((r) => r.join(' | ')),
  ]);

/** A card-sized PNG rendered from SVG text with sharp (a "scan": no text layer). */
export function makeSyntheticCardPng(lines = SYNTHETIC_CARD_LINES): Promise<Buffer> {
  const text = lines
    .map(
      (l, i) =>
        `<text x="40" y="${70 + i * 58}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#000">${xml(l)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${110 + lines.length * 58}"><rect width="100%" height="100%" fill="#fff"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A real, minimal .docx (opens in Word): paragraphs, a table, a content-control checkbox. */
export function makeBookingSheetDocx(): Buffer {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${xml(t)}</w:t></w:r></w:p>`;
  const cell = (t: string) =>
    `<w:tc><w:p><w:r><w:t xml:space="preserve">${xml(t)}</w:t></w:r></w:p></w:tc>`;
  const table = `<w:tbl>${SYNTHETIC_BOOKING_PROCEDURES.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
  const checkbox = `<w:p><w:r><w:t xml:space="preserve">Consent signed: </w:t></w:r><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt></w:p>`;
  const body = SYNTHETIC_BOOKING_PARAGRAPHS.map(p).join('') + table + checkbox;
  return writeZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:w14="${W14}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
