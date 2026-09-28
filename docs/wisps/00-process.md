# WISP 00: WISP process and document format

| Field | Value |
|---|---|
| Candidate number | 00; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | None |
| Implementation | Process proposal |
| Summary | How a WISP is written, reviewed and numbered, and what Draft, Proposed and Final mean. |
| Availability | Not applicable |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

Separate Ghost, the small rendezvous primitive, from Ghostly, its reference application, and make independently implementable extensions reviewable. WISP stands for Wire Interoperability Specification Proposal (and a wisp is a little ghost).

## Process

The catalogue was checked in this repository before preparing this series; no existing WISP registry was found. The initial 01-22 draft sequence was reorganized by family with explicit maintainer approval on 2026-09-22. The migration source is `numbering.json`; see [numbering and compatibility](NUMBERING.md). This is editorial organization, not a change to wire identifiers or implementation conformance. Acceptance of the catalogue by maintainers assigns the numbers. After assignment, a number MUST remain attached to its document and MUST NOT be reused, even if the proposal is withdrawn or superseded. Withdrawal/supersession is recorded in a disposition field and linked replacement, not by deleting or renumbering the entry. Assignment does not imply implementation or approval of the design.

- **Draft:** scope and alternatives are reviewable; wire details may be incomplete. Existing features can be documented as Drafts.
- **Proposed:** blockers are resolved, exact encodings, validation, versioning, security analysis and executable conformance cases are published. Maintainers record the review decision and reference the discussion.
- **Final:** two independent implementations interoperate for the declared profile, including negative cases. Publish versions, fixtures, results and unresolved limitations. Sharing the same core library across several clients is not two independent implementations.

A revision log records substantive changes (see [Revisions](#revisions)). Incompatible changes to Final behavior need a new version/profile and explicit migration; acceptance must determine whether a new WISP is needed. Draft dependencies do not become stable merely because a dependent document advances. A Final document MUST pin compatible, reviewed dependency versions. Process documents use an editorial review checklist rather than pretending to have a wire-level interoperability test.

## Required document structure

Headers: number/assignment state, title, status, editors, dependencies and implementation state. The revision and the date of the last change are not header rows in the source: they come from the change files ([Revisions](#revisions)). Body: purpose, existing behavior with source evidence, candidate requirements or profile, compatibility, security/privacy, open decisions, conformance and references. A wire proposal additionally specifies sizes, canonical bytes, failure behavior, state transitions and downgrade rules. Unknown fields, unsupported versions and mandatory extensions need separate handling.

### Header fields the site reads

WISP content is written in this directory only. The website's catalogue, reader and maps are generated from the documents (`npm run sync:references` in `website/`) and hold no text of their own about a WISP, so a change is written once, here. The same sync writes the index table in [README.md](README.md) from each header's title, Status and Availability; commit it with the change, or CI fails. Besides the fields above, the header table of every WISP carries these rows, in plain text (no Markdown, no links, except where a link is the value):

| Row | Required | Value |
|---|---|---|
| Summary | Yes | One line on what the WISP gives a person, shown on the catalogue. |
| Availability | Yes | `Available` (the app on `dev` does it), `Planned` or `Research` (not built), or `Not applicable` for a process document. Independent of Status: every WISP is a Draft. |
| Notes | No | The short caveat shown with the availability: what is experimental, which clients, which networks. Leave the row out when there is none. |
| Feature | No | One link to the part of the site that shows it, as `[label](https://ghostly.tools/#anchor)`. |
| Video | No | One link to its lesson video on the site, as `[Watch](https://ghostly.tools/videos/name.mp4)`. |

The family a WISP is listed under comes from its number's range, so there is no row for it. The Implementation row stays the technical statement (packages, versions, evidence); Summary and Notes are its plain-language counterpart and must not contradict it. The sync refuses a document without Summary and Availability.

### Revisions

Each change to a WISP is a file of its own, `changes/<wisp>/<YYYY-MM-DD>-<slug>.md` in this directory, holding one paragraph that says what changed (for example `changes/400-chat/2026-09-28-pinned-messages.md`). The document itself ends with a `## Revision log` section that points at its folder. The site builds the rest when it publishes the document: the log, newest first, and the Revision and Updated rows of the header, both from the newest change. A WISP with no change file fails the sync.

Changes logged before change files existed carry a revision number (`revision: 0.2.11` in a front matter block), and text written then cites those numbers ("revision 0.2.9"). A new change has no number: its revision is its date. Cite it by date ("revision 2026-09-28") where the text needs to say when something was added. Numbers handed out by hand could not stay unique while several pull requests changed one WISP at the same time, and each of them edited the same Revision row and the top of the same log.

Use MUST/SHOULD/MAY only for clearly scoped requirements. Never hide a design choice in a code example. Before Proposed, replace semantic sketches with fixed encodings and test vectors. Reference application behavior is evidence, not automatically the best protocol requirement.

## Review checklist and open decisions

Check catalogue uniqueness, dependency links, compatibility with deployed records, secret handling, denial of service limits and an independent implementation plan. Identify the maintainer/editor accepting the series and the public review location before assignment. No governance body, certification programme or extra WISP numbers are created here.

## References

[Contribution workflow](../../CONTRIBUTING.md), [security reporting](../../SECURITY.md), [interoperability criteria](INTEROP.md).

## Revision log

One file per change in [changes/00-process/](changes/00-process/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
