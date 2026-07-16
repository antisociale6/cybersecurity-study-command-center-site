# Detection Engineering Portfolio Project Worked Example

> **Synthetic lab boundary:** Fictional Northstar lab using four synthetic records. No person was monitored, no live system was tested, and no buyer or learner result is represented.

This complete miniature example shows how one behavior-based detection moves from a broad idea to labeled tests, a narrow tuning decision, and an analyst handoff. All names, events, identifiers, and results are fictional.

## 1. Detection hypothesis

- Behavior: Correlate a PowerShell process with a named lab marker-file creation on the same host and process identifier.
- ATT&CK mapping: `T1059.001`
- Correlation window: `30 seconds`
- Required fields: `timestamp_utc`, `host_label`, `process_image`, `process_guid`, `event_type`, `file_name`

```text
process_candidates = process_create where process_image equals powershell.exe
marker_events = file_create where file_name equals northstar-lab-detection-signal.txt
match when host_label and process_guid are equal and marker follows process within 30 seconds
```

## 2. Four-event fixture

| Event | Offset | Type | Process | Observation | Role |
|---|---:|---|---|---|---|
| SYN-E001 | +0s | process_create | SYN-PROC-001 | Baseline PowerShell file listing; no lab marker follows. | negative |
| SYN-E002 | +10s | process_create | SYN-PROC-002 | PowerShell starts the harmless lab signal sequence. | positive start |
| SYN-E003 | +14s | file_create | SYN-PROC-002 | The named lab marker appears four seconds later with the same process identifier. | positive completion |
| SYN-E004 | +40s | process_create | SYN-PROC-003 | Approved inventory script runs; no lab marker follows. | negative |

## 3. Evaluation and tuning

| Case | Events | Expected | Broad rule | Tuned rule | Reason |
|---|---|---|---|---|---|
| CASE-01 | SYN-E002 + SYN-E003 | match | match | match | The same host and process identifier create the named marker inside the 30-second window. |
| CASE-02 | SYN-E001 | no match | match | no match | PowerShell appears, but the named marker event never follows. |
| CASE-03 | SYN-E004 | no match | match | no match | The approved inventory activity has no correlated marker event. |

**Before - any PowerShell process:** TP 1, FP 2, TN 0, FN 0; precision 33%; recall 100%.

**After - correlated marker rule:** TP 1, FP 0, TN 2, FN 0; precision 100%; recall 100%.

**Tuning decision:** Replace the broad any-PowerShell condition with a same-host, same-process correlation that requires the named marker within 30 seconds. Keep the broad condition only as a research query, not an alert.

The tuned rule scored 100% precision and recall only on these three labeled synthetic cases. This is a fixture result, not production performance.

## 4. Analyst handoff

**Alert summary:** A PowerShell process and the named Northstar lab marker were observed on the same synthetic host with the same process identifier inside 30 seconds.

### Triage

1. Confirm both records share the expected host label and process identifier.
2. Verify the file event follows the process event within the configured window.
3. Check whether the activity belongs to the documented lab fixture or an approved administrative workflow.

### Escalate when

- The pair appears outside the documented synthetic lab fixture.
- The process context or adjacent evidence conflicts with the approved workflow.

### Close when

- The records match the documented fixture and the owner confirms the planned test.
- Evidence shows an approved workflow and the analyst records the reason for closure.

### Residual blind spots

- Missing or delayed file telemetry can hide the second half of the correlation.
- A changed process identifier or marker name prevents this exact rule from matching.
- A match establishes the lab behavior only; it does not establish malicious intent.

## 5. Limits

- The evaluation has only three labeled cases and cannot estimate production performance.
- The marker is a harmless fixture chosen for this example, not a general indicator of compromise.
- The rule depends on complete, correctly normalized process and file telemetry.
- No deployment, live monitoring, user attribution, or automated response is included.

## Continue with the same system

**What remains in the prepared membership:** The detailed lab guide, safe command cards, complete supplied test data, editable evidence log, review checklist, official-source notes, and portfolio brief stay together in the paid Month 10 sprint pack.

- [Read the matching public guide](https://antisociale6.github.io/cybersecurity-study-command-center-site/articles/detection-engineering-tuning.html?utm_source=github&utm_medium=template&utm_campaign=portfolio-template-library&utm_term=detection-tuning-evaluation-template&utm_content=traffic-free-first-v1)
- [Open the matching blank worksheet](https://antisociale6.github.io/cybersecurity-study-command-center-site/templates/detection-tuning-evaluation-template.html?utm_source=github&utm_medium=template&utm_campaign=portfolio-template-library&utm_term=detection-tuning-evaluation-template&utm_content=traffic-free-first-v1)
- [Claim the free authorization-and-evidence checklist](https://corcoran7.gumroad.com/l/vlcjuo?utm_source=github&utm_medium=template&utm_campaign=portfolio-template-library&utm_term=detection-tuning-evaluation-template&utm_content=traffic-free-first-v1)
- [Review the prepared 12-sprint membership](https://corcoran7.gumroad.com/l/vmyfq?utm_source=github&utm_medium=template&utm_campaign=portfolio-template-library&utm_term=detection-tuning-evaluation-template&utm_content=traffic-free-first-v1)

This example is not a learner result, customer testimonial, production benchmark, or guarantee.
