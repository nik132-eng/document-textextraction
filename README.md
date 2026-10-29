# Document Text Extraction (IDP) — Plan Repository

This repo holds the **plan** for an Intelligent Document Processing feature built on Amazon Textract. The feature accepts any PDF or image packet, splits it into forms (CMS-1500, UB-04, booking sheet, insurance card, ID, invoice, or generic), extracts every field with confidence and page location, and exposes the results for human-reviewed prefill in a host platform.

**There is no code here on purpose.** The build happens inside the host ("main") project, in that project's own coding style.

## Start here

| You want to… | Open |
|---|---|
| Understand the design | [`docs/superpowers/plans/2026-10-28-textract-idp/00-overview.md`](docs/superpowers/plans/2026-10-28-textract-idp/00-overview.md) |
| See what is left to do | [`STATUS.md`](docs/superpowers/plans/2026-10-28-textract-idp/STATUS.md) |
| Set up AWS | [`01a-aws-walkthrough.md`](docs/superpowers/plans/2026-10-28-textract-idp/01a-aws-walkthrough.md) |
| Build it in the main project (one prompt) | [`09-host-implementation-prompt.md`](docs/superpowers/plans/2026-10-28-textract-idp/09-host-implementation-prompt.md) |
| Only check how it would fit a project | [`08-integration-scan-prompt.md`](docs/superpowers/plans/2026-10-28-textract-idp/08-integration-scan-prompt.md) |

## Source documents

- [`idp-workflow.md`](idp-workflow.md): the confirmed workflow
- [`document-extraction-system-spec-1.md`](document-extraction-system-spec-1.md): form catalogs, canonical dictionary, rules, API, eval metrics
- [`Multi-Form Document Extraction for NestJS…`](Multi-Form%20Document%20Extraction%20for%20NestJS_%20CMS-1500,%20UB-04%20and%20B.md): storage research
