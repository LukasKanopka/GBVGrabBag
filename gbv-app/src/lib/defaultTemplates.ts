import type { ScheduleTemplateRound } from '../types/db';

/**
 * Returns the default schedule template for a given pool size.
 * Only 4- and 5-team pools are supported. For any other size, returns [].
 *
 * Each round defines:
 * - play: array of [seedA, seedB] pairs (we use one court per round by default here)
 * - ref: array with the seed of the ref team aligned by play index
 *
 * Note: Admins can customize templates per tournament in the UI; these are just defaults.
 */
export function defaultTemplateForPoolSize(size: number): ScheduleTemplateRound[] {
  if (size === 5) {
    // 10 total matches (single court ordering)
    // Round: [Team1 vs Team2] Ref
    // 1: [2 vs 5] Ref 3
    // 2: [1 vs 4] Ref 2
    // 3: [3 vs 5] Ref 1
    // 4: [2 vs 4] Ref 5
    // 5: [1 vs 3] Ref 4
    // 6: [4 vs 5] Ref 1
    // 7: [2 vs 3] Ref 4
    // 8: [1 vs 5] Ref 2
    // 9: [3 vs 4] Ref 5
    // 10: [1 vs 2] Ref 3
    return [
      { round: 1, play: [[2, 5]], ref: [3] },
      { round: 2, play: [[1, 4]], ref: [2] },
      { round: 3, play: [[3, 5]], ref: [1] },
      { round: 4, play: [[2, 4]], ref: [5] },
      { round: 5, play: [[1, 3]], ref: [4] },
      { round: 6, play: [[4, 5]], ref: [1] },
      { round: 7, play: [[2, 3]], ref: [4] },
      { round: 8, play: [[1, 5]], ref: [2] },
      { round: 9, play: [[3, 4]], ref: [5] },
      { round: 10, play: [[1, 2]], ref: [3] },
    ];
  }

  if (size === 4) {
    // 6 total matches (single court ordering)
    // Round: [Team1 vs Team2] Ref
    // 1: [1 vs 4] Ref 2
    // 2: [2 vs 3] Ref 1
    // 3: [1 vs 3] Ref 4
    // 4: [2 vs 4] Ref 3
    // 5: [1 vs 2] Ref 4
    // 6: [3 vs 4] Ref 2
    return [
      { round: 1, play: [[1, 4]], ref: [2] },
      { round: 2, play: [[2, 3]], ref: [1] },
      { round: 3, play: [[1, 3]], ref: [4] },
      { round: 4, play: [[2, 4]], ref: [3] },
      { round: 5, play: [[1, 2]], ref: [4] },
      { round: 6, play: [[3, 4]], ref: [2] },
    ];
  }

  // Unsupported sizes
  return [];
}