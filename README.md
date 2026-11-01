# Sonic Assistant Bridge

Experimental browser-based acoustic motion sensing with small, audio-free events for AI assistants. Derived from [KG-NINJA/SonicForceField](https://github.com/KG-NINJA/SonicForceField/tree/13fb3ba9c89a2bef36c364513dd4f2cc69709f0a).

[日本語 README](README.ja.md) · [Build your own private bridge](docs/build-your-own.md) · [Bridge setup and event contract](docs/assistant-bridge.md) · [Publication status](docs/publication.md)

[Repository](https://github.com/KG-NINJA/sonic-assistant-bridge) · [English app](https://kg-ninja.github.io/sonic-assistant-bridge/) · [日本語アプリ](https://kg-ninja.github.io/sonic-assistant-bridge/ja/)

The original SonicForceField repository and site remain separate and unchanged. The owned source and additions in this derivative are available under the [MIT license](LICENSE). Deployment status is recorded in the repository Actions runs; a successful local build alone does not establish public delivery.

The app supports explicit microphone sensing and a synthetic demo. It emits a high-frequency pilot tone during microphone sensing, analyzes Doppler sidebands and tone attenuation, and previews lifecycle and motion events. **dot is not connected.** Delivery starts disabled; an optional local mock receiver is the only configured destination. Server-side authenticated MCP Events code and private-capture UI are prepared for synthetic testing; a private Site has been registered but is not published, and no live subscription or callback signing secret has been created. See [connection prerequisites and blockers](docs/private-connection.md).

## Run locally

Install Node.js 22+ and npm, then run these commands in the source directory, including after downloading a fresh copy:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:8765`. The development UI is Japanese; the static build provides English at its root and Japanese at `/ja/`. On Windows, `start-sonic-forcefield.cmd` can start the server after dependency installation. No account or API key is required for local use.

Choose **Start demo** / **デモを開始** to try synthetic motion without microphone access or speaker output. Demo events have `mode: "synthetic"`. A successful demo does not establish hardware detection accuracy.

## Use the microphone

1. Open the app in desktop Chrome or Edge over HTTPS or localhost. Use speakers near the PC and a real microphone, rather than headphones or loopback input.
2. Click **Start microphone sensing** / **マイクで測定を開始**. Microphone access uses the browser's permission system; grant access if prompted. The app never starts sensing on page load or automatically resumes after stopping.
3. Keep the PC still while the received tone is checked and calibrated. This usually takes about eight seconds, and interference can extend it or prevent sensing. The UI shows microphone and tone activity separately.
4. Move a hand near the speaker to explore possible detections. Click **Stop** to stop input tracks, silence and stop tone oscillators, and close the audio context. Hiding the page or leaving it also stops sensing. Reported microphone interruption, disconnection, audio suspension, clipping during sensing, and processing stalls stop the session.

The default tone is 20 kHz at 2% digital amplitude, with a hard 3% maximum. Digital amplitude is not measured sound pressure or a safety guarantee. **Stop immediately if the tone is audible or uncomfortable.** The optional 18/19 kHz tones may be audible. Sensitivity settings do not increase output automatically.

## Preview and local reception

The assistant-events panel previews `session.started`, `motion.detected`, and `session.stopped`. Events contain a timestamp, temporary IDs, mode, state, reason, and a dB score where applicable. They never contain audio, FFT arrays, recordings, or conversation text. Motion episodes are deduplicated, with at least three seconds between motion events. Scores are not probabilities, confidence estimates, or distances.

To enable the mock receiver on the same local server:

```sh
BRIDGE_RECEIVER=1 npm start
```

In PowerShell, set `$env:BRIDGE_RECEIVER='1'` before running `npm start`. Select the local mock destination in the assistant-events panel, explicitly enable delivery, then start a demo or microphone session. Delivery uses only the same-origin `/bridge/events` route on literal `127.0.0.1`; arbitrary URLs and remote destinations are not supported. Disable delivery with its dedicated button. Hiding or reloading the page resets delivery to disabled. The ordinary **Stop** button ends sensing and attempts a final lifecycle delivery; it leaves delivery armed for the next explicit session.

```sh
npm run demo:bridge
```

This command generates synthetic events, checks them through a temporary loopback HTTP receiver, and closes it. It does not contact dot or use physical audio devices. See the [bridge guide](docs/assistant-bridge.md) for validation limits, duplicate handling, and the MCP Events adapter.

## Meaning and limits

| State | Meaning |
| --- | --- |
| Approach / recede | Doppler evidence consistent with motion toward / away from the sensor. |
| Mixed / unknown | Motion evidence without a dominant direction. |
| Obstruction | Reduced pilot reception; objects, muting, or volume changes can produce similar results. |
| No motion | No current qualifying evidence; does not establish absence or stationary presence. |

Scores are dB above the calibrated spectral baseline, or pilot attenuation in dB for obstruction. Waves and arrows are illustrative and do not show physical position or range. Extra sensitive mode uses a 1 dB threshold and 0.15 seconds of sustained evidence; the FFT adds its own time window. Movement episodes release after 0.65 seconds of calm evidence. Fans, interference, audio processing, and moving objects can cause false detections; static people and slow or sideways motion may be missed.

This experiment does not identify people, measure distance, establish occupancy, or provide security or emergency monitoring. No hardware detection range, accuracy, or success rate has been established.

## Data handling

Microphone samples are processed only in browser memory. The app does not record or upload audio, use analytics, or call an external detection API. Event metadata can still reveal activity times; check it before sharing. Preview and local mock state are in memory, without durable storage or delivery guarantees. A static Pages site sends no events to a backend; normal requests for site files and the host's access logs are separate from local sensing.

The MCP Events service adds authenticated HTTP boundaries, signed callback verification, bounded delivery, and unsubscribe handling. Its synthetic store cannot be used for production. Live integration still requires an approved authenticated host, atomic durable storage, and a proven safe outbound transport. The included Node HTTPS transport pins a validated IPv4 address; it cannot run as-is on Sites Workers. Sites-specific event discovery and actual dot receipt remain unverified. No connection or signing secret is created or embedded in the browser.

## Development and validation

```sh
npm test
npm run lint
npm run typecheck
npm run check
npm run build
npm run build:pages
npm run test:browser
npm run test:microphone
npm run test:private-bridge
```

The browser commands require Playwright and Chromium in the development environment. Existing installations can be selected with `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE`; these tools are not production dependencies. `test:browser` checks the synthetic UI while forbidding microphone and audio-context creation. `test:microphone` exercises browser media APIs using Chromium's fake microphone and synthetic WAV input, with speaker output muted. It checks explicit start, error paths, and resource cleanup, not physical microphones, speakers, or real-world sensing performance. Results and screenshots go to `artifacts/`; see [recorded validation](docs/validation.md) for the actual tested scope.

- `dist/`: portable local runtime with Three.js; run `node server.js` inside it with Node.js 22+. Use the source checkout for development checks.
- `pages/`: static English site, with Japanese at `pages/ja/`; only this directory is intended for Pages deployment.
- `scripts/english.js`: translations shared by the static build, which rejects untranslated Japanese in English application sources.

## Publication and provenance

The GitHub Actions workflow verifies the source and publishes only `pages/` to this repository's project site. Relative assets support `/sonic-assistant-bridge/`. Pages has no Node receiver or MCP backend; the local-delivery control is unavailable there. Pull requests run checks without deployment; `main` updates and manual runs deploy. See [publication and verification](docs/publication.md).

The base commit is `13fb3ba9c89a2bef36c364513dd4f2cc69709f0a` of SonicForceField. Although it did not contain a root license, the owner has authorized MIT for the owned source and additions in this derivative. [Third-party notices](THIRD_PARTY_NOTICES.md) preserve Three.js 0.186.0's original MIT copyright and license in each runtime/static build.

The method is inspired by [SoundWave — Microsoft Research](https://www.microsoft.com/en-us/research/project/soundwave-using-the-doppler-effect-to-sense-gestures/) and [Gupta et al., CHI 2012](https://www.microsoft.com/en-us/research/wp-content/uploads/2012/05/guptasoundwavechi2012.pdf), with a visualization concept related to [ForceField Wi-Fi](https://github.com/KG-NINJA/ForceField-Wi-Fi-fluctuation-detection). It does not claim to reproduce the research's accuracy.
