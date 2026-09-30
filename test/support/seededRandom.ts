/**
 * Park and Miller's minimal standard generator. Each call returns a whole number below `bound`,
 * and a seed gives the same numbers on every run. The seed must be a whole number
 * from 1 to 2,147,483,646.
 */
export function seededRandom(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % bound;
  };
}
