# UPDATEPLAN

## Objective
Reduce Theo's perceived slowness while preserving full screen-awareness for both `---CHAT---` and `---AGENT---` flows.

## Locked Constraint
- Do **not** skip screenshots for `---CHAT---`.
- Theo must continue answering questions about on-screen content in chat mode.

## Root-Cause Summary
Current latency is cumulative across serial stages:
1. STT transcription round-trip (Groq Whisper)
2. Classifier round-trip (separate LLM call)
3. Screenshot capture + full-grid overlay
4. PNG serialization (`optimize=True`)
5. Main multimodal LLM round-trip
6. Synchronous script execution for AGENT requests
7. TTS generation/start gating before API completion

Local measurement already observed:
- Screenshot+grid draw: ~35-155ms
- PNG optimize: ~300ms
- Image prep total: ~335-485ms

## Plan of Record

### 1) Add end-to-end timing instrumentation (first)
Implement stage timers in backend `/ai` pipeline and return/log structured timing fields:
- `stt_ms` (frontend-main-process side, if available)
- `classify_ms`
- `screenshot_ms`
- `encode_ms`
- `llm_ms`
- `script_ms`
- `tts_prep_ms`
- `total_ms`

Outcome:
- We can prove which stages dominate on real prompts.

### 2) Remove duplicate classification hop from frontend
Current frontend does `/ai/classify` then `/ai`.
Change flow to call only `/ai`, with backend performing classification once.

Outcome:
- Eliminates one network + LLM round-trip per request.

### 3) Keep screenshot for CHAT, optimize capture path
Maintain screenshot capture for all relevant requests, but optimize processing:
- Keep 1:1 coordinates for AGENT reliability.
- Make hot-path encoding cheaper (`optimize=False` by default on live `/ai` path).
- Keep heavier encoding only for debug/preview routes when needed.

Outcome:
- Preserves screen-aware chat while reducing CPU latency.

### 4) Stop blocking API response on TTS-start synchronization
Current backend waits for TTS started event (up to 5s).
Change behavior so `/ai` response returns immediately after AI parse/script dispatch, then TTS starts asynchronously.

Outcome:
- Large first-response latency reduction.

### 5) Reduce AGENT execution blocking
For AGENT requests:
- Run script execution in background worker/thread when safe.
- Keep frontend state updates aligned (`ai-go`/`ai-done`) with actual execution lifecycle.

Outcome:
- Faster API completion and better perceived responsiveness.

### 6) Guardrail pyautogui runtime speed
Set script runtime defaults in executor:
- `pyautogui.PAUSE` low default (e.g., `0.02`) unless explicitly overridden.
- Detect and cap excessive model-generated `time.sleep(...)` patterns unless required.

Outcome:
- Prevents slow scripts caused by conservative generated delays.

### 7) Validate with targeted scenarios
Run and compare before/after timings for:
1. CHAT prompt asking about screen content.
2. CHAT prompt with no action.
3. AGENT short single-step action.
4. AGENT multi-step action.
5. Failure paths (API timeout / script error) to ensure UX remains stable.

Acceptance criteria:
- CHAT remains screen-aware and accurate.
- First audible/visible Theo response is meaningfully faster.
- AGENT completion time improves or remains stable, with no coordinate regressions.

## Public/Interface Changes
- Keep `/ai` as primary endpoint.
- Optionally include timing object in `/ai` JSON response for observability.
- No behavior change that removes screenshot context from CHAT.

## Risks and Mitigations
- Risk: Asynchronous TTS/script can desync UI state.
  - Mitigation: emit explicit lifecycle events and log correlation IDs per request.
- Risk: Faster encoding impacts model visual fidelity.
  - Mitigation: A/B compare response quality on known visual prompts.
- Risk: Lower pauses can make automation brittle on slow UIs.
  - Mitigation: keep bounded retries and action-specific waits where required.

## Final Default Decisions
- Screenshot stays enabled for CHAT and AGENT.
- Prioritize first-response latency first, then full AGENT completion latency.
- Implement instrumentation before optimization so gains are measurable.
