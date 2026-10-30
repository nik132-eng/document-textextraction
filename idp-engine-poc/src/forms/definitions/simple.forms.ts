import type { FormDefinition } from '../form-definition';

/** Unknown documents: no fixed fields, every labelled value is captured as otherFields. */
export const GENERIC: FormDefinition = {
  id: 'GENERIC',
  version: 1,
  title: 'Generic document',
  description: 'Any document that matched no registered form. Captures every labelled value.',
  generic: true,
  fields: [],
};

/** Front of a US health-insurance member card. */
export const INSURANCE_CARD: FormDefinition = {
  id: 'INSURANCE_CARD',
  version: 1,
  title: 'Insurance card',
  description: 'Front of a health-insurance member ID card',
  cues: {
    phrases: ['MEMBER ID', 'GROUP', 'RXBIN', 'RXPCN', 'COPAY', 'PAYER ID', 'CUSTOMER SERVICE'],
    minScore: 0.5,
  },
  defaults: { minConfidence: 80 },
  fields: [
    {
      path: 'payer.name',
      label: 'Insurance company name',
      type: 'text',
      canonicalKey: 'payer.name',
      query: 'What is the insurance company or health plan name?',
    },
    { path: 'plan.name', label: 'Plan name', type: 'text', canonicalKey: 'plan.name' },
    {
      path: 'member.name',
      label: 'Member name',
      type: 'name',
      canonicalKey: 'insured.name.full',
      query: 'What is the member name?',
      required: true,
    },
    {
      path: 'member.id',
      label: 'Member ID',
      type: 'code',
      canonicalKey: 'insured.id',
      query: 'What is the member ID or subscriber ID?',
      required: true,
      minConfidence: 90,
    },
    {
      path: 'group.number',
      label: 'Group number',
      type: 'code',
      canonicalKey: 'insured.group_number',
    },
    {
      path: 'rx.bin',
      label: 'RxBIN',
      type: 'code',
      canonicalKey: 'plan.rx_bin',
      query: 'What is the RxBIN?',
    },
    {
      path: 'rx.pcn',
      label: 'RxPCN',
      type: 'code',
      canonicalKey: 'plan.rx_pcn',
      query: 'What is the RxPCN?',
    },
    { path: 'payer.id', label: 'Payer ID', type: 'code', canonicalKey: 'payer.id' },
    {
      path: 'copay.officeVisit',
      label: 'Office visit copay',
      type: 'text',
      canonicalKey: 'plan.copay',
    },
    {
      path: 'payer.phone',
      label: 'Customer service phone',
      type: 'phone',
      canonicalKey: 'payer.phone',
    },
  ],
};

/** Demographics block of a patient intake form. */
export const PATIENT_INTAKE: FormDefinition = {
  id: 'PATIENT_INTAKE',
  version: 1,
  title: 'Patient intake (demographics)',
  description: 'Patient registration / intake form, demographics section',
  cues: {
    phrases: [
      'PATIENT REGISTRATION',
      'INTAKE',
      'EMERGENCY CONTACT',
      'DATE OF BIRTH',
      'PRIMARY INSURANCE',
      'SUBSCRIBER',
    ],
    minScore: 0.5,
  },
  defaults: { minConfidence: 80 },
  fields: [
    {
      path: 'patient.lastName',
      label: 'Last name',
      type: 'name',
      canonicalKey: 'patient.name.last',
      query: 'What is the patient last name?',
      required: true,
    },
    {
      path: 'patient.firstName',
      label: 'First name',
      type: 'name',
      canonicalKey: 'patient.name.first',
      query: 'What is the patient first name?',
      required: true,
    },
    {
      path: 'patient.dob',
      label: 'Date of birth',
      type: 'date',
      canonicalKey: 'patient.dob',
      required: true,
      minConfidence: 90,
    },
    { path: 'patient.sex', label: 'Sex', type: 'text', canonicalKey: 'patient.sex' },
    {
      path: 'patient.phone',
      label: 'Phone',
      type: 'phone',
      canonicalKey: 'patient.phone',
      query: 'What is the patient phone number?',
    },
    {
      path: 'address.street',
      label: 'Street address',
      type: 'text',
      canonicalKey: 'patient.address.street',
    },
    { path: 'address.city', label: 'City', type: 'text', canonicalKey: 'patient.address.city' },
    { path: 'address.state', label: 'State', type: 'code', canonicalKey: 'patient.address.state' },
    { path: 'address.zip', label: 'ZIP code', type: 'code', canonicalKey: 'patient.address.zip' },
    {
      path: 'insurance.payerName',
      label: 'Primary insurance',
      type: 'text',
      canonicalKey: 'payer.name',
      query: 'What is the primary insurance company?',
    },
    {
      path: 'insurance.memberId',
      label: 'Policy / member ID',
      type: 'code',
      canonicalKey: 'insured.id',
      query: 'What is the insurance policy or member ID?',
    },
    {
      path: 'insurance.groupNumber',
      label: 'Group number',
      type: 'code',
      canonicalKey: 'insured.group_number',
    },
    {
      path: 'insurance.subscriberIsPatient',
      label: 'Subscriber is the patient (Self)',
      type: 'checkbox',
      canonicalKey: 'insured.relationship',
      keyAliases: ['Self', 'Subscriber is patient'],
    },
  ],
};
