# Ink Visualizer

Browser audio-reactive ink particle visualizer. Static site: TypeScript, Vite, three.js (WebGL2), Web Audio.

## Run

```sh
npm install
npm run dev       # http://localhost:5173
```

## Build

```sh
npm run check     # type-check
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ locally
```

`dist/` is fully static and uses relative paths, so it can be hosted from any folder.

## Status

M1: architecture, scaffold and control panel. Audio file upload works (MP3/MP4, or drop a
file anywhere). Microphone, link and tab capture are stubbed. The ink effect is a CPU
placeholder until M2. See [ARCHITECTURE.md](ARCHITECTURE.md).
