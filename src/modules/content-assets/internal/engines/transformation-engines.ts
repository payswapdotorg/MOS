/**
 * /content-assets first-party TRANSFORMATION ENGINE DOUBLES (MKT-064).
 *
 * The disclosed test doubles behind the REAL TransformationEngine port
 * contract — re-exported through the module's public entry (the 063
 * validation-guard re-export precedent) so tests and the composition
 * root construct them without touching module internals. PRODUCTION
 * REGISTERS NONE OF THEM BY DEFAULT (the MKT-056 discipline): the
 * composition-root engine registry stays empty and a kind with no
 * registered engine fails closed at request time.
 *
 * HONEST DISCLOSURE (what each double actually does — no real media
 * processing ships in this program; engines are pluggable capabilities):
 *
 *   - passthrough ('first-party:passthrough'): supports every frozen
 *     kind; for a single-ingredient request the output bytes are the
 *     input object's bytes VERBATIM (a true no-op — content-addressed,
 *     so the output converges to the same object key); a
 *     multi-ingredient request is REJECTED (the declared constraint).
 *     Declared effect: bytes pass through unchanged.
 *
 *   - format-double ('first-party:format-double'): the 'format' kind; a
 *     deterministic SYNTHETIC container — the output bytes are a bounded
 *     text header (the declared target format, from the request's
 *     parameters.target_format) followed by the input bytes. It does
 *     NOT transcode real media; it proves the full contract round trip
 *     (parameters in, measurable observations out). Declared effect:
 *     container metadata rewrite is SIMULATED.
 *
 *   - crop-double ('first-party:crop-double'): the 'crop' kind; a
 *     deterministic SYNTHETIC crop frame — the output bytes are a
 *     bounded text header encoding the declared crop rectangle
 *     (parameters x, y, width, height) followed by the input bytes. It
 *     does NOT process real pixels. Declared effect: spatial cropping
 *     is SIMULATED.
 *
 * Every double returns only MEASURED observations (the output byte
 * size) — nothing fabricated. Real first-party media-processing
 * capabilities and Extension/App engine bridges arrive as future
 * registered engines through the same port (architecture-lock-v1.6.md
 * rule 24: replaceable, never an alternate authority).
 */

import { InvalidRequestError } from '../../../../platform/errors/errors.ts';
import type {
  TransformationEngine,
  TransformationEngineInput,
  TransformationEngineOutput,
} from '../../public.ts';
import { TRANSFORMATION_KINDS } from '../../public.ts';

const HEADER_PREFIX = 'mos-tx-double';

function requireSingleIngredient(input: TransformationEngineInput): void {
  if (input.ingredients.length !== 1) {
    throw new InvalidRequestError(
      `the passthrough engine requires exactly one ingredient, found ${input.ingredients.length}`,
    );
  }
}

function requireParameters(
  input: TransformationEngineInput,
  keys: readonly string[],
): Map<string, unknown> {
  const problems: string[] = [];
  for (const key of keys) {
    if (!(key in input.parameters)) {
      problems.push(`parameters.${key} is required by the ${input.kind} engine double`);
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(problems.join('; '));
  }
  return new Map(Object.entries(input.parameters));
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function requirePositiveIntParameter(
  parameters: Map<string, unknown>,
  key: string,
): number {
  const value = parameters.get(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidRequestError(
      `parameters.${key} must be a non-negative integer (found '${String(value)}')`,
    );
  }
  return value;
}

/**
 * The passthrough engine — the no-op double for every frozen kind: the
 * single ingredient's bytes are the output, verbatim.
 */
export function createPassthroughTransformationEngine(): TransformationEngine {
  return {
    engineId: 'first-party:passthrough',
    supportedKinds: [...TRANSFORMATION_KINDS],
    declaredEffects: ['output bytes are the input bytes, unchanged'],
    declaredConstraints: ['exactly one ingredient'],
    executionKind: 'deterministic',
    async execute(input: TransformationEngineInput): Promise<TransformationEngineOutput> {
      requireSingleIngredient(input);
      const ingredient = input.ingredients[0]!;
      // A true no-op: the bytes pass through VERBATIM (content-addressed,
      // the output object converges to the same key — the discipline
      // proven by the round trip).
      return {
        outputBytes: ingredient.bytes,
        outputContentType: 'application/octet-stream',
        qualityObservations: [],
      };
    },
  };
}

/**
 * The format engine double — the 'format' kind as a deterministic
 * synthetic container (a bounded header carrying the declared target
 * format + the input bytes). NOT a real transcoder — disclosed.
 */
export function createFormatTransformationEngine(): TransformationEngine {
  return {
    engineId: 'first-party:format-double',
    supportedKinds: ['format'],
    declaredEffects: ['container metadata rewrite is simulated (bounded header + source bytes)'],
    declaredConstraints: ['exactly one ingredient', 'parameters.target_format required (bounded string)'],
    executionKind: 'deterministic',
    async execute(input: TransformationEngineInput): Promise<TransformationEngineOutput> {
      requireSingleIngredient(input);
      const parameters = requireParameters(input, ['target_format']);
      const targetFormat = parameters.get('target_format');
      if (typeof targetFormat !== 'string' || targetFormat.length === 0 || targetFormat.length > 64) {
        throw new InvalidRequestError(
          "parameters.target_format must be a bounded non-empty string (1-64 chars)",
        );
      }
      const header = encodeUtf8(
        `${HEADER_PREFIX}:format(${input.transformationId}) target=${targetFormat}\n`,
      );
      const source = input.ingredients[0]!.bytes;
      return {
        outputBytes: concat(header, source),
        outputContentType: 'application/octet-stream',
        qualityObservations: [],
      };
    },
  };
}

/**
 * The crop engine double — the 'crop' kind as a deterministic synthetic
 * crop frame (a bounded header encoding the declared rectangle + the
 * input bytes). NOT a real pixel processor — disclosed.
 */
export function createCropTransformationEngine(): TransformationEngine {
  return {
    engineId: 'first-party:crop-double',
    supportedKinds: ['crop'],
    declaredEffects: ['spatial cropping is simulated (bounded rectangle header + source bytes)'],
    declaredConstraints: [
      'exactly one ingredient',
      'parameters x, y, width, height required (non-negative integers)',
    ],
    executionKind: 'deterministic',
    async execute(input: TransformationEngineInput): Promise<TransformationEngineOutput> {
      requireSingleIngredient(input);
      const parameters = requireParameters(input, ['x', 'y', 'width', 'height']);
      const x = requirePositiveIntParameter(parameters, 'x');
      const y = requirePositiveIntParameter(parameters, 'y');
      const width = requirePositiveIntParameter(parameters, 'width');
      const height = requirePositiveIntParameter(parameters, 'height');
      if (width === 0 || height === 0) {
        throw new InvalidRequestError('parameters.width and parameters.height must be positive');
      }
      const header = encodeUtf8(
        `${HEADER_PREFIX}:crop(${input.transformationId}) rect=${x},${y},${width},${height}\n`,
      );
      const source = input.ingredients[0]!.bytes;
      return {
        outputBytes: concat(header, source),
        outputContentType: 'application/octet-stream',
        qualityObservations: [],
      };
    },
  };
}
