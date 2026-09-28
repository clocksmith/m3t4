# Third-party licenses

The root MIT license covers M3T4's original repository contents. Dependencies
retain their own licenses. `package-lock.json` records the resolved versions;
each dependency's distributed license text remains authoritative.

The optional legacy server proof verifier in `server/src/zk.ts` imports
`snarkjs`. The current dependency tree includes these GPL-3.0 packages:

| Package | Locked version |
| --- | --- |
| `snarkjs` | 0.7.6 |
| `@iden3/bigarray` | 0.0.2 |
| `@iden3/binfileutils` | 0.0.12 |
| `fastfile` | 0.0.20 |
| `ffjavascript` | 0.3.1 and 0.3.0 |
| `r1csfile` | 0.0.48 |
| `wasmbuilder` | 0.0.16 |
| `wasmcurves` | 0.2.2 |

These packages are not relicensed to MIT. The repository's MIT notice does
not replace the terms for distributing dependencies or combined builds.
The upstream [snarkjs license](https://github.com/iden3/snarkjs/blob/master/COPYING)
and installed package license files supply the corresponding notices.

Other locked dependencies declare MIT, Apache-2.0, ISC, BSD, or 0BSD licenses;
`node-forge` declares a BSD-3-Clause or GPL-2.0 choice. Retain the applicable
notices when distributing those packages.

## Meta Muzil browser dependencies

`client/muzil/assets/Manrope.ttf` is distributed under the SIL Open Font
License; see the adjacent `OFL.txt`.

`npm run sync:runtime` copies local Reploid and Doppler source with each
library's LICENSE. Model weights are not included; opt-in acquisition remains
subject to the selected model's terms.
