# Third-party notices

Sonic Assistant Bridge derives from the owner's SonicForceField source at
`13fb3ba9c89a2bef36c364513dd4f2cc69709f0a`. The owner authorized the MIT license
in the root `LICENSE` for the owned source and additions in this derivative.

The runtime bundles **Three.js 0.186.0**, distributed under the MIT license.
Its original copyright and license text are copied unchanged from
`node_modules/three/LICENSE` to `vendor/LICENSE` in the local runtime and in
both static language builds. The root license does not replace this notice.

Development dependencies are specified and pinned in `package-lock.json`.
They are not included in the portable runtime or static site. Their individual
licenses remain applicable when installed for development.

The acoustic method is inspired by the principles described in SoundWave
(Gupta et al., CHI 2012), linked in the README. No paper accuracy or hardware
detection performance is claimed.
