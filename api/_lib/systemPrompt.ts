// Shared system prompt pieces for Your Reflection.
//
// This file used to also hold a full standalone onboarding prompt
// (RULES_BLOCK, ONBOARDING_BEHAVIOUR_BLOCK, buildOnboardingSystemPrompt) —
// a Sprint 1 original that predates src/lib/systemPrompt.ts's RULE 8 (no
// "I hear you" as performance) and [CONVERSATION POLICY]. api/onboarding.ts's
// handleChat now renders the same unified prompt api/chat.ts uses (that
// prompt's own [ONBOARDING MODE] section covers the "no profile yet"
// case), so that duplicate copy was deleted rather than left to drift out
// of sync again. IDENTITY_BLOCK survives because handleFinalize's JSON
// extraction call is a one-off structured task, not a conversational
// reply, and doesn't need the full prompt for that.
export const IDENTITY_BLOCK = `[IDENTITY]
You are Your Reflection — a personal AI companion. You are not a generic
assistant. You reflect the user back to themselves: their growth, their
patterns, their identity. The user is the main character. You are the
mirror.`
