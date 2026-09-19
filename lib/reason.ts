/**
 * Why the flap did that.
 *
 * A DENY subevent tells you a cat was refused. It does not tell you why, and "why" is the whole
 * value: a refusal at 3am under a curfew is the system working, and a refusal of your own cat at
 * noon is something you want to look at.
 *
 * The lesson this module is built on, from `com.nibe.local`'s tasks/lessons.md:
 *
 *   "When the deliverable is an explanation, the interpretation is the deliverable. Shipping the
 *    raw inputs and leaving the reader to infer the conclusion is not a partial answer, it's a
 *    non-answer."
 *
 * So this returns a sentence, not a dump of the matched rule.
 *
 * The hard part is refusing to guess. We evaluate the policy ourselves, skipping rules that
 * depend on live frame data we do not receive. If a skipped rule sits above the one we matched,
 * the flap may have stopped there instead and our sentence would name the wrong cause. A
 * confidently wrong explanation is worse than none, so `PolicyOutcome.confident` gates every
 * specific answer and the fallback says plainly that we cannot tell.
 */

import { EventClassification, TransitPolicyRule } from './onlycat/models';
import { PolicyOutcome } from './policy';

/** An i18n key under `reason.` plus the values it interpolates. */
export interface ReasonText {
    key: string;
    tags: Record<string, string>;
}

function firstTimeRange(rule: TransitPolicyRule): string | null {
  const range = rule.criteria?.timeRange;
  if (!range) return null;
  return Array.isArray(range) ? (range[0] ?? null) : range;
}

function classifications(rule: TransitPolicyRule): EventClassification[] {
  const value = rule.criteria?.eventClassification;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Explain a refusal.
 *
 * `catName` is the display name we already resolved, or null for an unknown chip. The returned
 * key is looked up under `reason.` in the app locales, so every branch here needs a string in
 * all six languages.
 */
export function explainRefusal(
  outcome: PolicyOutcome,
  catName: string | null,
): ReasonText {
  const who = catName ?? '';
  const named = catName != null;

  // We cannot stand behind a specific cause: a rule we cannot evaluate sits above the match.
  // Say so. This is the branch that keeps the feature honest, and it is not a failure mode —
  // it is the correct answer whenever the owner's policy uses the flap's own sensors.
  if (!outcome.confident) {
    return { key: named ? 'reason.unknown_named' : 'reason.unknown', tags: { name: who } };
  }

  const { rule } = outcome;

  if (rule) {
    const classes = classifications(rule);

    if (classes.includes(EventClassification.Contraband)) {
      return { key: named ? 'reason.prey_named' : 'reason.prey', tags: { name: who } };
    }

    if (classes.includes(EventClassification.HumanActivity)) {
      return { key: 'reason.human', tags: {} };
    }

    const range = firstTimeRange(rule);
    if (range) {
      return {
        key: named ? 'reason.curfew_named' : 'reason.curfew',
        tags: { name: who, range },
      };
    }

    if (rule.criteria?.rfidCode !== undefined) {
      // A rule naming chips fired. Whether it named this cat or refused everyone else is
      // not something the matched rule alone tells us reliably, so the wording covers both:
      // "is not allowed in at the moment".
      return {
        key: named ? 'reason.not_allowed_named' : 'reason.not_allowed',
        tags: { name: who },
      };
    }

    return { key: named ? 'reason.rule_named' : 'reason.rule', tags: { name: who } };
  }

  // Nothing matched; the flap's idle state decided it.
  return { key: named ? 'reason.idle_named' : 'reason.idle', tags: { name: who } };
}

/**
 * The full sentence for `last_blocked_ONLYCAT`, which is a plain capability value rather than a
 * Flow token and therefore has to carry the cat's name itself.
 */
export function refusalLine(
  translate: (key: string, tags?: Record<string, string>) => string,
  outcome: PolicyOutcome,
  catName: string | null,
): string {
  const reason = explainRefusal(outcome, catName);
  return translate(reason.key, reason.tags);
}
