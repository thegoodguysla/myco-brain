/**
 * Save-memory milestones — the "Myco just stored its 50th memory" toast.
 *
 * Log-spaced thresholds, so they fire often early (when the user is still being
 * convinced) and rarely later (when they no longer need it): 10, 50, 100, 250,
 * then every 250. The spacing IS the decay. Pure and unit-tested; the wiring
 * counts after a real (non-replay) save and attaches the result when crossed.
 */

export const MILESTONE_THRESHOLDS = [10, 50, 100, 250];
const RECURRING_EVERY = 250;

/**
 * Given the workspace's memory count AFTER this save, return the milestone just
 * crossed, or null. Each created save increments the count by one, so a
 * milestone is "crossed" exactly when the new count equals a threshold.
 */
export function milestoneFor(newCount: number): number | null {
  if (!Number.isInteger(newCount) || newCount <= 0) return null;
  if (MILESTONE_THRESHOLDS.includes(newCount)) return newCount;
  if (newCount > RECURRING_EVERY && newCount % RECURRING_EVERY === 0) return newCount;
  return null;
}

export function milestoneMessage(n: number): string {
  const ord = ordinal(n);
  return `Myco just stored its ${ord} memory in this workspace.`;
}

function ordinal(n: number): string {
  const s = n.toLocaleString();
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${s}th`;
  switch (n % 10) {
    case 1:
      return `${s}st`;
    case 2:
      return `${s}nd`;
    case 3:
      return `${s}rd`;
    default:
      return `${s}th`;
  }
}

export interface Milestone {
  count: number;
  message: string;
}

export function buildMilestone(newCount: number): Milestone | null {
  const m = milestoneFor(newCount);
  return m ? { count: m, message: milestoneMessage(m) } : null;
}
