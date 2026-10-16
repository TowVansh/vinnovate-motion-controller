# Anything but a Game Controller: Tilt Maze

This project turns a phone into a real-time motion controller for a browser game on a laptop. You tilt the phone to roll a ball through a maze, and you shake it (or tap JUMP) to hop over holes. Up to 8 phones can join the same game and race each other.

**📱 Android app (APK): https://github.com/TowVansh/vinnovate-motion-controller/releases/latest/download/TiltPad.apk**

**🎮 Live game: https://tilt-maze.onrender.com.** Open it on a laptop, then scan its QR code with the app. Any network works and nothing needs installing on the laptop. Relay latency through the live server, measured from India, is p50 46 ms and p95 50 ms. It runs on Render's free tier, so the first load after 15 idle minutes takes about 50 s.

| Part | Folder | Tech |
|---|---|---|
| Phone app | `app/` | React Native (Expo SDK 58): `expo-sensors` DeviceMotion, haptics, keep-awake, Android App Link |
| Browser game | `public/index.html` | HTML canvas: maze physics, QR code, players, leaderboard, ghosts |
| Server | `server.js` | Node.js + `ws`: room pairing and relay, leaderboard |

## Setup

**Game and server (laptop):**
```
npm install
npm start            # Windows PowerShell: npm.cmd start, or node server.js
```
Open **http://localhost:5180** on the laptop. It shows a room code and a QR code.

**Phone app:**
1. Install `TiltPad.apk` from the link above. Allow "install unknown apps" for your browser when Android asks.
2. Open **Tilt Pad**, type your name and the **4-letter code** shown on the game screen, and tap **▶ START**.
3. Hold the phone flat, tap **Set level**, and tilt to roll your ball. Shake the phone or tap **JUMP** to hop over holes.

The app connects to the live game (`wss://tilt-maze.onrender.com`) by default, so any network works. To use a game running on your own laptop, open **Server** in the app and type the address shown on the laptop (for example `192.168.137.1:5180`). The phone must then be on the same network as the laptop.

Shortcut: scanning the online game's QR code with the phone's normal camera app opens Tilt Pad and joins directly. This uses an Android App Link, verified through `/.well-known/assetlinks.json`.

**Build the APK yourself:**
```
cd app
npm install
npx expo prebuild -p android
cd android && ./gradlew assembleRelease     # needs JDK 17+ and the Android SDK (ANDROID_HOME)
```

**No app installed?** The same controller also runs in a phone browser at `https://<laptop-ip>:5443/pad.html` (scan the QR code with the camera app). Accept the self-signed certificate warning once, since browsers only give motion sensors to HTTPS pages. `npm run share` instead opens a Cloudflare quick tunnel so the browser pad works from any network.

## Features

| Requirement | How it is done |
|---|---|
| Gyro + accelerometer mapping | `deviceorientation` gamma/beta map to steering, with ±12° for full speed and clamping. `devicemotion` with acceleration above 14 m/s² counts as a shake and makes the ball jump (700 ms cooldown). |
| Pairing | The server issues a 4-letter room code, which you type into the app. The game also shows a QR code: the phone camera opens the app straight into the room (App Link), and the browser pad uses the same QR. |
| WebSocket streaming | The phone sends `{t:'s',x,y}` at 60 Hz, only when the value changes, plus a 250 ms keepalive. The server is a thin relay with no game logic. |
| Browser game | A ball-balancing tilt maze with walls, holes (fall means respawn), a finish flag, race timer and falls counter. Physics uses sub-stepping, so fast balls cannot pass through walls. |
| Calibration | **Calibrate** stores the current pose as neutral. It is saved in `localStorage`, so it survives reloads. |
| Connection status + auto-reconnect | Both sides show a status dot. Both reconnect with exponential backoff (300 ms up to 4 s). The phone has a stable device id, so it gets the same ball and color back. A reloaded game reclaims the same room code, so phones do not need to re-pair. A 5 s server heartbeat drops dead sockets quickly. |

**Bonus items done:**
- Local multiplayer: up to 8 phones, each with its own colored ball, racing in one maze
- Leaderboard: each phone enters a name, and the best finish time per name is ranked and saved to `leaderboard.json`, so it survives restarts. The game shows the top 10, and the phone shows your time, your rank and whether it's a new personal best.
- Independent runs: every run has its own clock, and falling into a hole sends you back to start for a fresh run, with a 3-2-1 countdown and the timer reset. After finishing, a new run starts with a 3-2-1 countdown (shown on the laptop and on the phone, with a buzz on each beat). **Restart race** gives everyone a countdown.
- Ghosts: each finished run is recorded at 20 Hz. While you play, a **blue ghost** replays your personal best and a **yellow ghost** replays the #1 run on the leaderboard, both on your run's clock, so you can see exactly where you are ahead or behind.
- On-screen JUMP button
- Vibration feedback: a bump scaled to impact speed when you hit a wall, a double buzz when you fall into a hole, and a pattern when you finish
- Live latency display on both the phone and the game
- Screen wake lock
- Arrow keys and space on the laptop, for testing without a phone

## Latency approach

- **Thin relay:** the server never parses game state. It tags the message with the phone id and forwards it, which takes well under 1 ms.
- **No compression** (`perMessageDeflate: false`) and Nagle is off (the `ws` default `noDelay`), so small packets go out immediately.
- **Latest value only:** the phone sends its current tilt every 16 ms. The game uses the newest value, so a delayed packet can never build up a queue of stale input.
- **Measured, not guessed:** every second the phone sends `ping{ts}`, the game echoes `pong{ts}`, and the phone shows round trip / 2. That number is also sent with the sensor packets, so the game shows each player's latency.

`npm test` runs an end-to-end check on a real server. It covers pairing, a bad code being rejected, relaying 500 sensor packets, haptics, phone reconnect keeping its color, game reload keeping the room, and that the maze is solvable. It also prints relay latency. On localhost: **p50 0.16 ms, p95 0.40 ms, p99 0.74 ms**. Over Wi-Fi, expect roughly 5–30 ms, and the pad shows the live value.

## Structure

```
server.js          HTTP + HTTPS static server and WebSocket relay (rooms, pairing, heartbeat)
public/index.html  laptop game (maze, physics, QR, players, haptics out)
public/pad.html    phone controller (sensors, calibration, jump, latency, reconnect)
public/manifest.json, sw.js, icon.svg   PWA install
test.js            end-to-end test + latency benchmark
```

Tech stack: Node.js, `ws`, `selfsigned` (generates the local HTTPS certificate), plain HTML/Canvas/JS on both clients, and qrcodejs from a CDN.
