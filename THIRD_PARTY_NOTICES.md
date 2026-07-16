# Third-party notices

DITA Editor includes or uses open-source dependencies listed in `bun.lock`. Their own licenses and notices remain controlling for those components. The packaged extension bundles the following runtime packages and their transitive dependencies:

- `parse5` (MIT) and `entities` (BSD-2-Clause)
- `postcss` (MIT), `nanoid` (MIT), `picocolors` (ISC), and `source-map-js` (BSD-3-Clause)
- `postcss-value-parser` (MIT)

The compiled bundle also contains esbuild runtime helpers under the MIT License.

The Code of Conduct is adapted from Contributor Covenant 2.1, licensed under Creative Commons Attribution 4.0.

The Apache License 2.0 text is provided in `LICENSE` by the Apache Software Foundation.

The factual interoperability fixture `test/coexistence-extension.json` contains a minimized contribution manifest derived from JeremyJeanne's DitaCraft extension version 0.8.1. DitaCraft declares the MIT License. Copyright remains with JeremyJeanne and its contributors; the fixture is retained only to detect extension-identifier collisions.
