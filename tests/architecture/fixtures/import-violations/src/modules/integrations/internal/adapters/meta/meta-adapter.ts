// CLEAN POSITIVE (fixture): a concrete MODULE-INTERNAL adapter file — the
// /integrations first-party connector home. The fixture composition root
// imports it (the SANCTIONED wiring — frozen module-dependency-matrix.md
// "Composition root": "external integration adapters are wired at the
// composition root"); the planted violations import it from the api layer
// and from another module (both must be rejected).
export class FixtureMetaAdapter {
  readonly key = 'meta-ads';
}
