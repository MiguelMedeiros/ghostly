# WISP 00: WISP process and document format

| Field | Value |
|---|---|
| Candidate number | 00; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | None |
| Implementation | Process proposal |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

Separate Ghost, the small rendezvous primitive, from Ghostly, its reference application, and make independently implementable extensions reviewable. WISP is the working document name; this draft does not decide its expanded acronym.

## Process

The catalogue was checked in this repository before preparing this series; no existing WISP registry was found. The initial 01-22 draft sequence was reorganized by family with explicit maintainer approval on 2026-09-22. The migration source is `numbering.json`; see [numbering and compatibility](NUMBERING.md). This is editorial organization, not a change to wire identifiers or implementation conformance. Acceptance of the catalogue by maintainers assigns the numbers. After assignment, a number MUST remain attached to its document and MUST NOT be reused, even if the proposal is withdrawn or superseded. Withdrawal/supersession is recorded in a disposition field and linked replacement, not by deleting or renumbering the entry. Assignment does not imply implementation or approval of the design.

- **Draft:** scope and alternatives are reviewable; wire details may be incomplete. Existing features can be documented as Drafts.
- **Proposed:** blockers are resolved, exact encodings, validation, versioning, security analysis and executable conformance cases are published. Maintainers record the review decision and reference the discussion.
- **Final:** two independent implementations interoperate for the declared profile, including negative cases. Publish versions, fixtures, results and unresolved limitations. Sharing the same core library across several clients is not two independent implementations.

A revision log records substantive changes. Incompatible changes to Final behavior need a new version/profile and explicit migration; acceptance must determine whether a new WISP is needed. Draft dependencies do not become stable merely because a dependent document advances. A Final document MUST pin compatible, reviewed dependency versions. Process documents use an editorial review checklist rather than pretending to have a wire-level interoperability test.

## Required document structure

Headers: number/assignment state, title, status, revision, editors, date, dependencies and implementation state. Body: purpose, existing behavior with source evidence, candidate requirements or profile, compatibility, security/privacy, open decisions, conformance and references. A wire proposal additionally specifies sizes, canonical bytes, failure behavior, state transitions and downgrade rules. Unknown fields, unsupported versions and mandatory extensions need separate handling.

Use MUST/SHOULD/MAY only for clearly scoped requirements. Never hide a design choice in a code example. Before Proposed, replace semantic sketches with fixed encodings and test vectors. Reference application behavior is evidence, not automatically the best protocol requirement.

## Review checklist and open decisions

Check catalogue uniqueness, dependency links, compatibility with deployed records, secret handling, denial of service limits and an independent implementation plan. Identify the maintainer/editor accepting the series and the public review location before assignment. No governance body, certification programme or extra WISP numbers are created here.

## References

[Contribution workflow](../../CONTRIBUTING.md), [security reporting](../../SECURITY.md), [interoperability criteria](INTEROP.md).
