# Anime4K for Jellyfin

Real-time [Anime4K](https://github.com/bloc97/Anime4K) upscaling in the Jellyfin web player. It runs in the viewer's browser on their own GPU (WebGPU), so viewers install nothing and the server needs no changes.

A button next to the subtitles button opens a small panel: on/off, mode, max height.

<img width="604" height="490" alt="image" src="https://github.com/user-attachments/assets/077066ef-3bbd-4dfb-8fc3-d3a271d926b1" />


## Install

Needs the [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) plugin.

1. Install JS Injector and restart Jellyfin.
2. In the dashboard, open JS Injector and add a script. Either:
   - use a **script URL** (make sure to enable "Allow external script URLs):
     ```
     https://cdn.jsdelivr.net/gh/poprox24/Anime4K-for-Jellyfin@main/Anime4kJellyfin.js
     ```
   - or paste in the contents of `Anime4kJellyfin.js`
3. Save and hard-refresh the web client (Ctrl+Shift+R).

## Use

Play something and click the sparkle button. A dot under it means it's running. Shift+U toggles it too.

- **Mode**: which Anime4K pipeline to run, see below.
- **Max height**: cap on the output height. Auto is the viewer's screen height. Sources already at or above the cap are left alone.

Settings are saved per browser.

| Mode | Use for |
|---|---|
| A | 1080p anime. Cleans up blur and compression, then upscales. Good default. |
| B | 720p, or ringing/aliasing from downscaling. Softer cleanup. |
| C | 480p or clean sources. No cleanup pass. |
| A+A, B+B, C+A | Same as above with a second cleanup pass. Slower, can oversharpen. |
| CNN x2 M / VL / UL | Plain 2x upscale, no cleanup. M is lightest, UL heaviest. |

Descriptions come from the [Anime4K docs](https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Advanced.md). Pick whatever looks best.

## Notes

- Web client only. The Jellyfin apps don't run injected scripts.
- Needs a browser with WebGPU and a GPU it can use. In the console, `await navigator.gpu.requestAdapter()` returning `null` means it won't work there. Chromium on Linux usually needs extra flags, Firefox needs advanced config settings(look it up)
- Tested on Firefox with Mode A, the CNN x2 models and ASS subtitles. The other modes, HDR and other subtitle formats are untested.
- The 2x models always upscale 2x, then the result is scaled down to the max height. On a weak GPU use CNN x2 M or lower the max height.
- Loads the Anime4K-WebGPU library from esm.sh, pinned to 1.0.0.
- It depends on Jellyfin's player markup, so a Jellyfin update can break it.

## Troubleshooting

Open the console (F12) and filter by `a4k`. The panel's status line shows the same thing. If the video goes black, turn it off with Shift+U or via the UI and open an issue with those lines and your browser.

## Credits

[Anime4K](https://github.com/bloc97/Anime4K) by bloc97, [Anime4K-WebGPU](https://github.com/Anime4KWebBoost/Anime4K-WebGPU) (MIT), [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) by n00bcodr. Panel styling is inspired by [Abyss](https://github.com/AumGupta/abyss-jellyfin).

Not affiliated with any of them.

## License

[MIT](LICENSE)
