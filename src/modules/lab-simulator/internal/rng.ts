/**
 * /lab-simulator RNG (LAB-005) — THE DECLARED SEEDED GENERATOR
 * ('lab-simulator-splitmix64' + 'lab-sim-rng-v1', both recorded on
 * every world-model configuration): the pure deterministic
 * splitmix64 stream.
 *
 * The reproducibility contract (spec/architecture-v1.7-marketing-lab.md
 * §9: "A simulator run MUST be able to reproduce a trajectory given a
 * recorded seed/configuration"): the master seed is an unsigned 64-bit
 * integer recorded as a decimal string; every per-subsystem stream is
 * derived from it through a FIXED, disclosed mixing (master seed XOR
 * FNV-1a64(label), then one splitmix64 step) — the derived-seed
 * lineage recorded on every SEED record. The same master seed always
 * produces the same streams, the same consumption order and the same
 * trajectory, step-for-step.
 *
 * Pure functions: no clock, no I/O, no ambient state. BigInt
 * arithmetic is exact; the only float conversion (nextFloat) is the
 * deterministic IEEE division Number(value) / 2^64 — the same u64
 * always yields the same float.
 */

const MASK64 = 0xffff_ffff_ffff_ffffn;
const GAMMA = 0x9e37_79b9_7f4a_7c15n;
const MIX_A = 0xbf58_476d_1ce4_e5b9n;
const MIX_B = 0x94d0_49bb_1331_11ebn;
const TWO_POW_64 = 2 ** 64;
/** The FNV-1a 64 prime (1099511628211 = 0x100000001b3). */
const FNV_PRIME = 0x100_0000_01b3n;

/** One splitmix64 step: returns the advanced state + the mixed output value. */
function splitmix64Step(state: bigint): { next: bigint; value: bigint } {
  const s = (state + GAMMA) & MASK64;
  let z = s;
  z = ((z ^ (z >> 30n)) * MIX_A) & MASK64;
  z = ((z ^ (z >> 27n)) * MIX_B) & MASK64;
  z = z ^ (z >> 31n);
  return { next: s, value: z & MASK64 };
}

/** The FNV-1a 64-bit hash of an ASCII label (the deterministic label mixing). */
export function fnv1a64(label: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= BigInt(label.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * The derived-seed derivation (the DISCLOSED formula): the decimal
 * u64 output of one splitmix64 step over (masterSeed XOR
 * FNV-1a64(label)). Deterministic: the same master seed + label
 * always derive the same per-subsystem seed.
 */
export function deriveLabSimulatorSeed(masterSeed: string, label: string): string {
  const master = BigInt(masterSeed);
  const mixed = (master ^ fnv1a64(label)) & MASK64;
  const { value } = splitmix64Step(mixed);
  return value.toString(10);
}

/** The seeded deterministic stream (one per subsystem label — the fixed consumption order is the engine's). */
export interface LabSimulatorRng {
  readonly label: string;
  /** The next raw u64 (advances the stream). */
  nextU64(): bigint;
  /** The next uniform float in [0, 1) (advances the stream — the deterministic IEEE conversion). */
  nextFloat(): number;
  /** The next integer in [minInclusive, maxExclusive) (advances the stream). */
  nextInt(minInclusive: number, maxExclusive: number): number;
}

/**
 * Creates the seeded deterministic splitmix64 stream for one label —
 * the declared generator behind the whole simulator. The state starts
 * at the derived seed's own stream position: the first output is the
 * splitmix64 step over the derived state (so distinct labels on the
 * same master seed never collide and re-deriving a label replays its
 * exact stream).
 */
export function createLabSimulatorRng(masterSeed: string, label: string): LabSimulatorRng {
  const derived = BigInt(deriveLabSimulatorSeed(masterSeed, label));
  let state = derived;
  return {
    label,
    nextU64(): bigint {
      const step = splitmix64Step(state);
      state = step.next;
      return step.value;
    },
    nextFloat(): number {
      return Number(this.nextU64()) / TWO_POW_64;
    },
    nextInt(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) {
        return minInclusive;
      }
      return minInclusive + Math.floor(this.nextFloat() * (maxExclusive - minInclusive));
    },
  };
}
