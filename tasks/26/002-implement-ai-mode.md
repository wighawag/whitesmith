---
id: "26-002"
issue: 26
title: "Implement the 'ai' auto-work mode with LLM-based issue analysis"
depends_on: ["26-001"]
---

## Description

Implement the `ai` auto-work mode that uses an LLM to analyze the issue content and determine whether whitesmith should work on it directly (auto-work) or wait for manual merge. When mode is `ai`, the system first checks the trigger conditions (label/body keyword). If not triggered, it calls the configured model to make the decision.

## Acceptance Criteria

- When `autoWorkMode` is `ai` and trigger conditions are not met, the system calls an LLM to decide
- The LLM call uses the agent harness (i.e. `pi --print --no-tools --no-session`) with `autoWorkModel` if set, otherwise falls back to the main `model` from config
- The prompt sent to the LLM includes the issue title, body, and asks for a yes/no decision on whether to auto-work
- The LLM response is parsed to extract a boolean decision
- `isAutoWorkEnabled()` is already async from task 001; this task adds the actual AI call logic for the `ai` mode path
- Tests cover the `ai` mode: triggered short-circuit, AI says yes, AI says no, AI call failure (defaults to false)

## Implementation Notes

### Approach
- `isAutoWorkEnabled()` is already async from task 001. This task adds the AI decision logic for the `ai` mode path.
- Use the agent harness (`PiHarness`) to make the LLM call. Specifically, use `pi --print --no-tools --no-session` with the configured provider and model (or `autoWorkModel` if set). This is consistent with how the codebase already calls LLMs (see `PiHarness.validate()` which uses a similar `--print --no-tools --no-session` pattern for a quick single-shot call).
- `isAutoWorkEnabled()` needs access to the agent harness config (agentCmd, provider, model/autoWorkModel). Pass the relevant config or the harness itself.
- The prompt should be something like: "Given this GitHub issue, should an AI agent work on it immediately without human review? Answer YES or NO. Issue: [title] [body]"
- Parse the LLM response: look for YES/NO. On failure or ambiguous response, default to `false` (don't auto-work).
- Update `test/auto-work.test.ts` with new async test cases, mocking the LLM call (mock `execSync` or extract the LLM call into a mockable function)

### Files to modify
- `src/auto-work.ts`: Add AI decision logic (LLM call via agent harness command)
- `src/types.ts`: Possibly add `agentCmd` to the fields passed to `isAutoWorkEnabled` if not already available
- `test/auto-work.test.ts`: Add tests for AI mode with mocked LLM calls
