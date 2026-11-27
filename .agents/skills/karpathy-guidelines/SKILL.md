---
name: karpathy-guidelines
description: Behavioral guidelines for writing, reviewing, debugging, or refactoring code with less overengineering, clearer assumptions, minimal diffs, and verifiable success criteria.
---

# Karpathy-Inspired Coding Guidelines

This community-created skill is based on Andrej Karpathy's public observations about common LLM coding pitfalls. It is not an official Andrej Karpathy release.

Source repository: https://github.com/multica-ai/andrej-karpathy-skills
Upstream file: https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md
Upstream README declares MIT; the upstream repository currently does not provide a standalone LICENSE file. Preserve this attribution when redistributing.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them—don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it—don't delete it.

When your changes create orphans:
- Remove imports, variables, or functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let the agent loop independently. Weak criteria ("make it work") require constant clarification.

## USMS-specific application

- Do not weaken authentication, authorization, tenant isolation, payment protections, or secrets handling.
- Treat inventory and order consistency as critical correctness requirements.
- Follow existing architecture and migration conventions; do not invent parallel systems.
- Prefer targeted tests for the changed behavior, then run the relevant typecheck, lint, and build commands when feasible.
- Do not deploy, run production migrations, or modify secrets as part of routine coding unless explicitly requested.

## How to tell it is working

- Fewer unnecessary changes in diffs.
- Fewer rewrites caused by overcomplication.
- Clarifying questions before risky implementation, not after mistakes.
- Small, focused pull requests with relevant verification.
