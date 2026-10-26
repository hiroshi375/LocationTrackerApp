# Summary time correction: pre-build regression

## Change

Stationary coordinates can collapse to one route point. Summary start/end times
previously came from that simplified route, shortening the recorded period.
`getRecordingPeriod` now selects the earliest/latest valid timestamp from the
owner-filtered raw logs. Route distance, coordinate simplification, activity
classification, ownership checks, database schema and pending queues are unchanged.
Existing records are not migrated or rewritten by this change.

The change is JavaScript-only and is not yet distributed. Existing Android/iOS
1.0.5 OTA updates still contain the earlier discard-metadata fix, not this change.

## Regression results (2026-10-25)

- 80 TypeScript tests passed: local DynamoDB old/new API compatibility, save,
  discard chunks/retries, late-upload fencing, sharing recovery, native inbox
  handoff, stop/restart receipts, time boundaries and login diagnostics.
- 24 CommonJS tests passed against freshly synthesized local backend templates
  and mocked/native source adapters. Includes two service-level tests confirming
  summary create/update payloads use the raw end timestamp, preserve manual
  classification and exclude another owner's timestamp.
- 12 real SQLite tests passed, covering inbox/acknowledgment, discard markers,
  scoped deletion and preservation of other users/sessions.
- Frontend/backend TypeScript checks, 30 generated-client operations and
  `git diff --check` passed.
- Actual five-point stationary replay now produces the 64.843-second raw period.

All backend mutation tests used loopback DynamoDB with dummy credentials. The
backend synthesis used a deliberately non-production identity and did not deploy.
No production mutation, additional build, OTA delivery or store publication ran.

`src/tests/backgroundRecordingStateStore.test.ts` requires an Expo development
build with native SQLite. A first attempt to run it under Node failed at the
React Native loader; it is not included in the passing counts and was not run on
a device in this regression. The Node-compatible suite was rerun successfully.
Synthetic pending-data tests do not establish retention of nonzero pending data
on the normal iOS installation, whose actual queue count remains unavailable.

## Read-only impact audit

Production time-field projections covered 282 summaries and 48,040 location rows.
273 summaries had usable matching raw logs: 258 matched and 15 differed at the
end timestamp; three had collapsed nonzero periods. Nine lacked sufficient raw
evidence. No end-day/week/month shifts were observed. Two absent month keys were
not incorrect existing month keys. Some legacy periods extend past the last raw
point, so not all differences are attributed to route simplification.
No historical record or aggregate was repaired. Consistent reads across tables
are not a single transactional snapshot.

## Remaining release gates

General release remains on hold. After separate approval, create artifacts with
the corrected embedded JavaScript and verify embedded/offline launch, update
selection, signatures, production configuration and overwrite retention. Original
Android26/iOS11 artifacts still embed the missing discard-operation metadata.
Neither changing this source nor publishing OTA modifies those store artifacts.
Historical corrections require a separate reviewed plan; no bulk migration is
part of this patch. Earlier iOS delay, stationary distance and uncertain recording
start observations remain recorded independently.
